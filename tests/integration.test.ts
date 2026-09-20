import { projectPath } from '../src/paths.js';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import { Database } from '../src/db.js';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { Storage, byteRange } from '../src/storage.js';
import { ImportService, validatePackage, safePath } from '../src/importer.js';
import type { ProgressWrite } from '../contracts/src/index.js';
const id = 'a-quiet-morning',
  build = 'original-speech-v1',
  revision = 'original-text-v1';
let db: Database,
  server: Awaited<ReturnType<typeof createApp>>,
  ops: ImportService,
  root: string,
  alice: any,
  bob: any;
async function clone(name: string, edit: (book: any, chapter: any) => void) {
  const dir = resolve(root, name);
  await cp(projectPath('contracts/fixtures', id), dir, { recursive: true });
  const b = JSON.parse(await readFile(resolve(dir, 'book.json'), 'utf8')),
    c = JSON.parse(await readFile(resolve(dir, 'chapters/c01.json'), 'utf8'));
  edit(b, c);
  await writeFile(resolve(dir, 'book.json'), JSON.stringify(b));
  await writeFile(resolve(dir, 'chapters/c01.json'), JSON.stringify(c));
  return dir;
}
const mutation = (version = 0): ProgressWrite => ({
  textRevision: revision,
  sourceBuildId: build,
  chapterId: 'c01',
  sentenceId: 'c01-s0001',
  preferredSpeed: 1.25,
  expectedVersion: version,
  clientMutationId: randomUUID(),
});
beforeAll(async () => {
  root = await mkdtemp(resolve(tmpdir(), 'pidan-mini-test-'));
  db = new Database(process.env.TEST_DATABASE_URL || '', 'memory://');
  await db.migrate();
  const storage = new Storage(resolve(root, 'media'));
  server = await createApp(db, storage, false);
  await server.app.listen(0, "127.0.0.1");
  ops = new ImportService(db, storage);
  await ops.import(projectPath('contracts/fixtures', id), 'sample-public', 'test');
  await ops.publish(id, build, null, 'test');
  alice = await server.services.auth.session('test', 'alice');
  bob = await server.services.auth.session('test', 'bob');
});
afterAll(async () => {
  await server?.app.close();
  await db?.close();
});
describe('HTTP contracts and private media', () => {
  it('validates actual responses and null tombstones against the published DTO schemas',async()=>{
    const ajv=new Ajv({strict:false,validateFormats:false});
    const validate=(name:string,data:unknown)=>ajv.compile({$ref:`#/components/schemas/${name}`,components:server.document.components})(data);
    expect(validate('BookPage',await server.services.books.list(null,'sample',20))).toBe(true);
    expect(validate('Chapter',await server.services.books.chapter(id,build,'c01',null))).toBe(true);
    expect(validate('ProgressResult',{version:2,progress:null})).toBe(true);
    expect(validate('ProgressResult',{version:2,progress:{bogus:'value'}})).toBe(false);
  });
  it('lists real books with an envelope, no chapters or signed URLs', async () => {
    const r = await request(server.app.getHttpServer()).get('/v1/books?audience=sample');
    expect(r.status).toBe(200);
    expect(r.body.requestId).toBeTruthy();
    expect(r.body.data.items[0]).toMatchObject({
      bookId: id,
      chapterCount: 3,
      sentenceCount: 24,
      playableCount: 23,
      chapterAudioAvailableCount: 3,
    });
    expect(r.body.data.items[0].chapters).toBeUndefined();
  });
  it('rejects unauthenticated cloud progress and invalid speeds', async () => {
    const r = await request(server.app.getHttpServer()).get(
      `/v1/me/progress/${id}?textRevision=${revision}`,
    );
    expect(r.status).toBe(401);
    const bad = await request(server.app.getHttpServer())
      .put(`/v1/me/progress/${id}`)
      .set('Authorization', `Bearer ${alice.accessToken}`)
      .send({ ...mutation(), preferredSpeed: 2 });
    expect(bad.status).toBe(422);
  });
  it('serves signed GET/HEAD/Range and authenticates every request', async () => {
    const p = await server.services.books.playback(id, build, 'c01-s0001', 'sentence', null);
    const url = new URL(p.url);
    const r = await request(server.app.getHttpServer())
      .get(url.pathname + url.search)
      .set('Range', 'bytes=0-9');
    expect(r.status).toBe(206);
    expect(r.headers['content-length']).toBe('10');
    expect(r.headers['content-range']).toMatch(/^bytes 0-9\//);
    const head = await request(server.app.getHttpServer())
      .head(url.pathname + url.search)
      .set('Range', 'bytes=0-9');
    expect(head.status).toBe(200);
    expect(head.text).toBeUndefined();
    const invalid = await request(server.app.getHttpServer()).get(
      url.pathname + '?exp=9999999999&sig=bad',
    );
    expect(invalid.status).toBe(403);
    const unsat = await request(server.app.getHttpServer())
      .get(url.pathname + url.search)
      .set('Range', 'bytes=999999999-');
    expect(unsat.status).toBe(416);
  });
  it('does not sign unplayable sentences but allows independent full audio', async () => {
    await expect(
      server.services.books.playback(id, build, 'c01-s0003', 'sentence', null),
    ).rejects.toMatchObject({ code: 'SENTENCE_UNPLAYABLE' });
    const p = await server.services.books.playback(id, build, 'c01', 'chapter', null);
    expect(p.duration).toBeGreaterThan(10);
    expect(Date.parse(p.expiresAt) - Date.parse(p.issuedAt)).toBeGreaterThan(890000);
  });
  it.each([
    { missing: 'AppID', appid: '', appSecret: 'test-only-secret' },
    { missing: 'AppSecret', appid: 'test-only-appid', appSecret: '' },
  ])('explains missing $missing without contacting WeChat or creating a session', async ({ appid, appSecret }) => {
    const original = { appid: config.appid, appSecret: config.appSecret };
    const exchange = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected WeChat request'));
    const session = vi.spyOn(server.services.auth, 'session').mockRejectedValue(new Error('Unexpected session creation'));
    try {
      Object.assign(config, { appid, appSecret });
      const r = await request(server.app.getHttpServer())
        .post('/v1/auth/wechat')
        .send({ code: 'test-login-code' });
      expect(r.status).toBe(503);
      expect(r.body.error).toEqual({
        code: 'SERVICE_UNAVAILABLE',
        message: '微信登录尚未配置，请先体验样本',
        details: {},
      });
      expect(r.body.requestId).toBeTruthy();
      expect(exchange).not.toHaveBeenCalled();
      expect(session).not.toHaveBeenCalled();
      expect((await request(server.app.getHttpServer()).get('/v1/books?audience=sample')).status).toBe(200);
    } finally {
      Object.assign(config, original);
      exchange.mockRestore();
      session.mockRestore();
    }
  });
  it('has no mock login endpoint or fabricated WeChat login success', async () => {
    const r = await request(server.app.getHttpServer())
      .post('/v1/auth/mock')
      .send({ userId: 'alice' });
    expect(r.status).toBe(404);
  });
  it('rejects malformed request bodies and oversized progress', async () => {
    const r = await request(server.app.getHttpServer())
      .put(`/v1/me/progress/${id}`)
      .set('Authorization', `Bearer ${alice.accessToken}`)
      .send({ ...mutation(), padding: 'x'.repeat(5000) });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('INVALID_REQUEST');
  });
});
describe('transactional progress', () => {
  it('first-write concurrency only advances once, including duplicate request replay', async () => {
    const user = await server.services.auth.session('test', 'concurrent');
    const p = mutation();
    const results = await Promise.all([
      server.services.progress.mutate(user.user.id, id, p),
      server.services.progress.mutate(user.user.id, id, p),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].version).toBe(1);
    await expect(
      server.services.progress.mutate(user.user.id, id, { ...p, sentenceId: 'c01-s0002' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
  it('does not let two devices overwrite one another; reset leaves a tombstone', async () => {
    const p = mutation();
    const a = await server.services.progress.mutate(alice.user.id, id, p);
    expect(a.version).toBe(1);
    await expect(
      server.services.progress.mutate(alice.user.id, id, mutation()),
    ).rejects.toMatchObject({ code: 'PROGRESS_CONFLICT', details: { version: 1 } });
    const reset = { textRevision: revision, expectedVersion: 1, clientMutationId: randomUUID() };
    const cleared = await server.services.progress.mutate(alice.user.id, id, reset, true);
    expect(cleared).toEqual({ version: 2, progress: null });
    expect(await server.services.progress.mutate(alice.user.id, id, reset, true)).toEqual(cleared);
    await expect(
      server.services.progress.mutate(alice.user.id, id, mutation(1)),
    ).rejects.toMatchObject({ code: 'PROGRESS_CONFLICT' });
    expect(await server.services.progress.get(bob.user.id, id, revision)).toEqual({
      version: 0,
      progress: null,
    });
  });
  it('keeps a stored success replayable after build retirement', async () => {
    const user = await server.services.auth.session('test', 'retirement');
    const p = mutation();
    const first = await server.services.progress.mutate(user.user.id, id, p);
    await db.query("UPDATE book_builds SET status='retired' WHERE book_id=$1 AND build_id=$2", [
      id,
      build,
    ]);
    expect(await server.services.progress.mutate(user.user.id, id, p)).toEqual(first);
    await expect(
      server.services.progress.mutate(user.user.id, id, mutation(1)),
    ).rejects.toMatchObject({ code: 'BUILD_RETIRED' });
    await db.query("UPDATE book_builds SET status='active' WHERE book_id=$1 AND build_id=$2", [
      id,
      build,
    ]);
  });
});
describe('content pipeline and isolation', () => {
  it('paginates more than fifty summaries without duplicates and rejects cross-audience cursors', async () => {
    const metadata = await server.services.books.current(id, null);
    await db.transaction(async (tx) => {
      for (let i = 0; i < 51; i++) {
        const bookId = `page-${String(i).padStart(3, '0')}`;
        await tx.query("INSERT INTO books(book_id,visibility) VALUES($1,'sample-public')", [
          bookId,
        ]);
        await tx.query(
          "INSERT INTO book_builds(book_id,build_id,text_revision,digest,text_digest,status,metadata) VALUES($1,'test','r','hash','text','active',$2)",
          [bookId, JSON.stringify({ ...metadata, bookId, buildId: 'test' })],
        );
        await tx.query("UPDATE books SET active_build_id='test' WHERE book_id=$1", [bookId]);
      }
    });
    let cursor: string | undefined,
      firstCursor = '',
      all: string[] = [];
    do {
      const page = await server.services.books.list(null, 'sample', 20, cursor);
      all.push(...page.items.map((b) => b.bookId));
      cursor = page.nextCursor || undefined;
      firstCursor ||= cursor || '';
    } while (cursor);
    expect(all.filter((b) => b.startsWith('page-'))).toHaveLength(51);
    expect(new Set(all).size).toBe(all.length);
    await expect(
      server.services.books.list(alice.user.id, 'member', 20, firstCursor),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  it('supports fifty simultaneous read requests without leaking private content', async () => {
    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        request(server.app.getHttpServer()).get('/v1/books?audience=sample&limit=20'),
      ),
    );
    expect(
      results.every(
        (r) =>
          r.status === 200 && r.body.data.items.every((b: any) => b.visibility === 'sample-public'),
      ),
    ).toBe(true);
    console.log(
      `50 concurrent local reads: ${Date.now() - start} ms total (isolated integration database, not production benchmark)`,
    );
  });
  it('keeps old packages without chapterAudio valid and rejects invalid identity/count/audio metadata', async () => {
    const old = await clone('legacy', (_b, c) => {
      delete c.chapterAudio;
    });
    expect((await validatePackage(old)).chapters[0].chapterAudio).toBeUndefined();
    for (const [name, edit] of Object.entries({
      version: (b: any, c: any) => {
        c.schemaVersion = 3;
      },
      mixed: (b: any, c: any) => {
        c.buildId = 'other';
      },
      count: (b: any, c: any) => {
        b.chapters[0].playableCount = 8;
      },
      audio: (b: any, c: any) => {
        c.chapterAudio.duration = 999;
      },
      duplicate: (b: any, c: any) => {
        c.sentences[1].id = c.sentences[0].id;
      },
    })) {
      const path = await clone(name, edit);
      await expect(validatePackage(path)).rejects.toThrow();
    }
  });
  it('validates deterministic package digests and import idempotency', async () => {
    const a = await validatePackage(projectPath('contracts/fixtures', id));
    const b = await validatePackage(projectPath('contracts/fixtures', id));
    expect(a.digest).toBe(b.digest);
    expect(
      (await ops.import(projectPath('contracts/fixtures', id), 'sample-public', 'test')).reused,
    ).toBe(true);
  });
  it('rejects explicit null chapterAudio and unsafe paths', async () => {
    const dir = await clone('bad-audio', (_b, c) => {
      c.chapterAudio = null;
    });
    await expect(validatePackage(dir)).rejects.toThrow('整章扩展');
    for (const p of ['../secret', '%2e%2e/secret', 'C:/secret', 'https://evil/a', 'audio\\x.mp3'])
      expect(() => safePath(p)).toThrow();
  });
  it('rejects different contents under the same build without changing live data', async () => {
    const dir = await clone('different', (_b, c) => {
      c.sentences[0].text = 'Changed words.';
    });
    await expect(ops.import(dir, 'sample-public', 'test')).rejects.toThrow('相同 buildId');
    expect((await server.services.books.current(id, null)).buildId).toBe(build);
  });
  it('filters private books and prevents cursor reuse across identities', async () => {
    const source = projectPath('contracts/fixtures/the-lantern-garden');
    await ops.import(source, 'private', 'test');
    await ops.publish('the-lantern-garden', build, null, 'test');
    await db.query('INSERT INTO book_access(user_id,book_id) VALUES($1,$2)', [
      alice.user.id,
      'the-lantern-garden',
    ]);
    expect((await server.services.books.list(bob.user.id, 'member', 20)).items).toHaveLength(0);
    expect((await server.services.books.list(alice.user.id, 'member', 20)).items).toHaveLength(1);
    await expect(
      server.services.books.current('the-lantern-garden', bob.user.id),
    ).rejects.toMatchObject({ code: 'BOOK_FORBIDDEN' });
    await expect(
      server.services.books.list(bob.user.id, 'member', 20, 'bad.cursor'),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await db.query('UPDATE book_access SET revoked_at=now() WHERE user_id=$1', [alice.user.id]);
    await expect(
      server.services.books.playback('the-lantern-garden', build, 'c01', 'chapter', alice.user.id),
    ).rejects.toMatchObject({ code: 'BOOK_FORBIDDEN' });
  });
  it('ready/staged builds cannot be read; retained cutoff refuses short grants', async () => {
    await db.query("UPDATE book_builds SET status='ready' WHERE book_id=$1 AND build_id=$2", [
      id,
      build,
    ]);
    await expect(server.services.books.snapshot(id, build, null)).rejects.toMatchObject({
      code: 'BUILD_NOT_FOUND',
    });
    await db.query(
      "UPDATE book_builds SET status='retained',retain_until=now()+interval '5 seconds' WHERE book_id=$1 AND build_id=$2",
      [id, build],
    );
    await expect(
      server.services.books.playback(id, build, 'c01', 'chapter', null),
    ).rejects.toMatchObject({ code: 'BUILD_UPDATE_REQUIRED' });
    await db.query(
      "UPDATE book_builds SET status='active',retain_until=NULL WHERE book_id=$1 AND build_id=$2",
      [id, build],
    );
  });
  it('checks expected active version and makes revoked builds non-publishable', async () => {
    await expect(ops.publish(id, build, 'wrong', 'test')).rejects.toThrow('活动构建');
    await ops.revoke('the-lantern-garden', build, 'test');
    await expect(ops.publish('the-lantern-garden', build, null, 'test')).rejects.toThrow(
      '不可发布',
    );
  });
});
describe('Range semantics', () => {
  it('handles suffix/open ranges, HEAD caller and malformed/multiple ranges', () => {
    expect(byteRange('bytes=-4', 10)).toEqual({ status: 206, start: 6, end: 9 });
    expect(byteRange('bytes=3-', 10)).toEqual({ status: 206, start: 3, end: 9 });
    expect(byteRange('bytes=8-2', 10).status).toBe(400);
    expect(byteRange('bytes=0-1,3-4', 10).status).toBe(200);
    expect(byteRange('items=2-3', 10).status).toBe(200);
  });
});

describe('Content types and optional TV seasons', () => {
  const contentBuild = 'typed-v1';
  let groupedDirectory: string;
  async function packageFor(name: string, type?: string, grouped = false) {
    const dir = resolve(root, name);
    await cp(projectPath('contracts/fixtures', id), dir, { recursive: true });
    const path = resolve(dir, 'book.json');
    const b = JSON.parse(await readFile(path, 'utf8'));
    b.book.id = name;
    b.buildId = contentBuild;
    if (type) b.contentType = type;
    if (grouped) {
      b.seasons = [{ id: 's1', title: '第一季', order: 1 }, { id: 's2', title: '第二季', order: 2 }];
      b.chapters.forEach((c: any, i: number) => {
        c.seasonId = i < 2 ? 's1' : 's2';
        c.episodeNumber = i < 2 ? i + 1 : 1;
      });
    }
    for (const entry of b.chapters) {
      const path = resolve(dir, entry.data);
      const c = JSON.parse(await readFile(path, 'utf8'));
      c.bookId = name; c.buildId = contentBuild;
      await writeFile(path, JSON.stringify(c));
    }
    await writeFile(path, JSON.stringify(b));
    return dir;
  }
  const get = (path: string) => request(server.app.getHttpServer()).get(path);
  function contract(name: string, value: unknown) {
    const ajv = new Ajv({ strict: false, validateFormats: false });
    // OpenAPI 3.0 boolean exclusiveMinimum differs from JSON Schema draft-07.
    const components = JSON.parse(JSON.stringify(server.document.components), (_key, value) => {
      if (value && typeof value === 'object' && typeof value.exclusiveMinimum === 'boolean') {
        if (value.exclusiveMinimum) { value.exclusiveMinimum = value.minimum; delete value.minimum; }
        else delete value.exclusiveMinimum;
      }
      return value;
    });
    const validate = ajv.compile({ $ref: `#/components/schemas/${name}`, components });
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  }
  beforeAll(async () => {
    for (const [name, type, grouped, visibility] of [
      ['typed-book', undefined, false, 'sample-public'],
      ['typed-blog', 'blog', false, 'sample-public'],
      ['typed-movie-a', 'movie', false, 'sample-public'],
      ['typed-movie-b', 'movie', false, 'sample-public'],
      ['typed-movie-private', 'movie', false, 'private'],
      ['typed-tv-flat', 'tv', false, 'sample-public'],
      ['typed-tv-grouped', 'tv', true, 'sample-public'],
    ] as const) {
      const dir = await packageFor(name, type, grouped);
      if (grouped) groupedDirectory = dir;
      await ops.import(dir, visibility, 'typed-test');
      await ops.publish(name, contentBuild, null, 'typed-test');
    }
    await db.query('INSERT INTO book_access(user_id,book_id) VALUES($1,$2)', [alice.user.id, 'typed-movie-private']);
  });
  it('filters before pagination and applies permissions to every content type', async () => {
    for (const type of ['book', 'blog', 'movie', 'tv']) {
      const r = await get('/v1/books?contentType=' + type);
      expect(r.status).toBe(200);
      expect(r.body.data.items.length).toBeGreaterThan(0);
      expect(r.body.data.items.every((b: any) => b.contentType === type && b.visibility === 'sample-public')).toBe(true);
      contract('BookPage', r.body.data);
    }
    const first = await get('/v1/books?contentType=movie&limit=1');
    expect(first.body.data.items.map((b: any) => b.bookId)).toEqual(['typed-movie-a']);
    const second = await get('/v1/books?contentType=movie&limit=1&cursor=' + encodeURIComponent(first.body.data.nextCursor));
    expect(second.body.data.items.map((b: any) => b.bookId)).toEqual(['typed-movie-b']);
    expect(second.body.data.nextCursor).toBeNull();
    const alicePage = await get('/v1/books?contentType=movie&audience=member').set('Authorization', `Bearer ${alice.accessToken}`);
    expect(alicePage.body.data.items.map((b: any) => b.bookId)).toEqual(['typed-movie-private']);
    const bobPage = await get('/v1/books?contentType=movie&audience=member').set('Authorization', `Bearer ${bob.accessToken}`);
    expect(bobPage.body.data.items).toEqual([]);
    expect((await get('/v1/books/typed-movie-private')).status).toBe(401);
    expect((await get('/v1/books/typed-movie-private').set('Authorization', `Bearer ${bob.accessToken}`)).status).toBe(403);
    expect((await request(server.app.getHttpServer()).post(`/v1/books/typed-movie-private/builds/${contentBuild}/sentences/c01-s0001/playback`).set('Authorization', `Bearer ${bob.accessToken}`)).status).toBe(403);
    expect((await get('/v1/books?contentType=movie&audience=member')).status).toBe(401);
  });
  it('rejects invalid types and cross-type/all cursor reuse while accepting legacy all cursors', async () => {
    for (const query of ['contentType=podcast', 'contentType=', 'contentType=tv&contentType=book'])
      expect((await get('/v1/books?' + query)).status).toBe(400);
    const filtered = await get('/v1/books?contentType=movie&limit=1');
    const cursor = encodeURIComponent(filtered.body.data.nextCursor);
    expect((await get('/v1/books?contentType=tv&cursor=' + cursor)).status).toBe(400);
    expect((await get('/v1/books?cursor=' + cursor)).status).toBe(400);
    expect((await get('/v1/books?contentType=movie&cursor=' + cursor).set('Authorization', `Bearer ${alice.accessToken}`)).status).toBe(400);
    const all = await get('/v1/books?limit=1');
    expect((await get('/v1/books?contentType=book&cursor=' + encodeURIComponent(all.body.data.nextCursor))).status).toBe(400);
    const { sign } = await import('../src/books.js');
    const body = Buffer.from(JSON.stringify({ user: null, audience: 'sample', after: 'page-000' })).toString('base64url');
    const legacy = encodeURIComponent(body + '.' + sign(body));
    expect((await get('/v1/books?cursor=' + legacy)).status).toBe(200);
    expect((await get('/v1/books?contentType=book&cursor=' + legacy)).status).toBe(400);
  });
  it('normalizes stored legacy snapshots without rewriting metadata or digests', async () => {
    await db.query("UPDATE book_builds SET metadata=metadata-'contentType'-'unitCount'-'seasons' WHERE book_id='typed-book'");
    const before = (await db.query("SELECT metadata,digest FROM book_builds WHERE book_id='typed-book'")).rows[0];
    const r = await get('/v1/books/typed-book');
    expect(r.body.data).toMatchObject({ contentType: 'book', unitCount: 3, seasons: [] });
    contract('Book', r.body.data);
    const listing = await get('/v1/books?contentType=book&limit=50');
    // Existing pagination fixtures may precede this item, so follow filtered pages.
    let page = listing.body.data;
    while (!page.items.some((b: any) => b.bookId === 'typed-book') && page.nextCursor)
      page = (await get('/v1/books?contentType=book&limit=50&cursor=' + encodeURIComponent(page.nextCursor))).body.data;
    expect(page.items.find((b: any) => b.bookId === 'typed-book')).toMatchObject({ contentType: 'book', unitCount: 3, seasonCount: 0 });
    expect((await db.query("SELECT metadata,digest FROM book_builds WHERE book_id='typed-book'")).rows[0]).toEqual(before);
  });
  it('returns flat and grouped TV directories and distinct signed audio for same-number episodes', async () => {
    const flat = (await get('/v1/books/typed-tv-flat')).body.data;
    expect(flat.seasons).toEqual([]);
    expect(flat.chapters.map((c: any) => [c.episodeNumber, c.seasonId])).toEqual([[1, undefined], [2, undefined], [3, undefined]]);
    contract('Book', flat);
    const grouped = (await get('/v1/books/typed-tv-grouped')).body.data;
    expect(grouped.seasons.map((s: any) => s.id)).toEqual(['s1', 's2']);
    expect(grouped.chapters.map((c: any) => [c.id, c.seasonId, c.episodeNumber])).toEqual([
      ['c01', 's1', 1], ['c02', 's1', 2], ['c03', 's2', 1],
    ]);
    contract('Book', grouped);
    const summary = (await get('/v1/books?contentType=tv')).body.data.items.find((b: any) => b.bookId === 'typed-tv-grouped');
    expect(summary).toMatchObject({ unitCount: 3, seasonCount: 2 });
    expect(summary.seasons).toBeUndefined(); expect(summary.chapters).toBeUndefined();
    const chapter = (await get(`/v1/books/typed-tv-grouped/builds/${contentBuild}/chapters/c03`)).body.data;
    expect(chapter).toMatchObject({ seasonId: 's2', episodeNumber: 1 });
    contract('Chapter', chapter);
    const audioIds = [];
    for (const chapterId of ['c01', 'c03']) {
      const r = await request(server.app.getHttpServer()).post(`/v1/books/typed-tv-grouped/builds/${contentBuild}/sentences/${chapterId}-s0001/playback`);
      expect(r.status).toBe(201); contract('Playback', r.body.data);
      audioIds.push(r.body.data.audioId);
      const url = new URL(r.body.data.url);
      expect((await get(url.pathname + url.search).set('Range', 'bytes=0-15')).status).toBe(206);
    }
    expect(new Set(audioIds).size).toBe(2);
  });
  it('keeps correct episode progress across season metadata updates and newly added seasons', async () => {
    const bookId = 'typed-tv-grouped';
    const headers = { Authorization: `Bearer ${alice.accessToken}` };
    const saved = await request(server.app.getHttpServer()).put('/v1/me/progress/' + bookId).set(headers)
      .send({ ...mutation(), sourceBuildId: contentBuild, chapterId: 'c03', sentenceId: 'c03-s0001' });
    expect(saved.status).toBe(200);
    const wrong = await request(server.app.getHttpServer()).put('/v1/me/progress/' + bookId).set(headers)
      .send({ ...mutation(1), sourceBuildId: contentBuild, chapterId: 'c01', sentenceId: 'c03-s0001' });
    expect(wrong.status).toBe(422);
    const r = await get(`/v1/me/progress/${bookId}?textRevision=${revision}`).set(headers);
    expect(r.body.data.progress).toMatchObject({ chapterId: 'c03', sentenceId: 'c03-s0001' });
    const newBuild = 'typed-v2';
    const dir = resolve(root, 'typed-tv-updated');
    await cp(groupedDirectory, dir, { recursive: true });
    const path = resolve(dir, 'book.json');
    const b = JSON.parse(await readFile(path, 'utf8'));
    b.buildId = newBuild; b.seasons[0].title = '第一季（新版目录）';
    // Regroup existing stable episodes into an added season; text/order stay intact.
    b.seasons.push({ id: 's3', title: '第三季', order: 3 });
    b.chapters[1].seasonId = 's2'; b.chapters[1].episodeNumber = 1;
    b.chapters[2].seasonId = 's3';
    for (const e of b.chapters) {
      const f = resolve(dir, e.data); const c = JSON.parse(await readFile(f, 'utf8'));
      c.buildId = newBuild; await writeFile(f, JSON.stringify(c));
    }
    await writeFile(path, JSON.stringify(b));
    await ops.import(dir, 'sample-public', 'typed-test');
    await ops.publish(bookId, newBuild, contentBuild, 'typed-test');
    expect((await get(`/v1/me/progress/${bookId}?textRevision=${revision}`).set(headers)).body.data).toEqual(r.body.data);
    const current = (await get('/v1/books/' + bookId)).body.data;
    expect(current.chapters.find((c: any) => c.id === r.body.data.progress.chapterId)).toMatchObject({ seasonId: 's3', episodeNumber: 1 });
    const old = (await get(`/v1/books/${bookId}/builds/${contentBuild}`)).body.data;
    expect(old.chapters[2].seasonId).toBe('s2');
  });
  it('rejects invalid content/season metadata before database or storage writes', async () => {
    const dir = await packageFor('typed-invalid', 'tv', true);
    const path = resolve(dir, 'book.json');
    const original = JSON.parse(await readFile(path, 'utf8'));
    const cases = [
      (b: any) => { b.contentType = 'video'; },
      (b: any) => { b.contentType = null; },
      (b: any) => { b.seasons = null; },
      (b: any) => { b.seasons[1].id = 's1'; },
      (b: any) => { b.seasons[1].order = 1; },
      (b: any) => { b.seasons[0].order = 0; },
      (b: any) => { b.seasons[0].title = ' '; },
      (b: any) => { b.chapters[0].seasonId = 'missing'; },
      (b: any) => { delete b.chapters[0].episodeNumber; },
      (b: any) => { b.chapters[1].episodeNumber = 1; },
      (b: any) => { b.chapters[1].episodeNumber = 1.5; },
      (b: any) => { b.chapters[2].seasonId = 's1'; b.chapters[2].episodeNumber = 3; },
      (b: any) => { b.chapters[0].seasonId = 's2'; },
      (b: any) => { b.seasons = []; },
      (b: any) => { b.contentType = 'movie'; },
      (b: any) => { b.coverUrl = 'http://example.com/a.jpg'; },
      (b: any) => { b.coverUrl = 'https://user:secret@example.com/a.jpg'; },
      (b: any) => { b.chapters[1].id = b.chapters[0].id; },
    ];
    for (const change of cases) {
      const b = structuredClone(original); change(b);
      await writeFile(path, JSON.stringify(b));
      await expect(ops.import(dir, 'sample-public', 'typed-test')).rejects.toThrow();
    }
    expect((await db.query("SELECT 1 FROM books WHERE book_id='typed-invalid'")).rows).toHaveLength(0);
    const flat = structuredClone(original); flat.seasons = [];
    flat.chapters.forEach((c: any) => { delete c.seasonId; delete c.episodeNumber; });
    flat.chapters[0].episodeNumber = 2; // default second episode is also 2
    await writeFile(path, JSON.stringify(flat));
    await expect(validatePackage(dir)).rejects.toThrow('集号');
    const ordinary = structuredClone(flat); ordinary.contentType = 'blog'; delete ordinary.seasons;
    await writeFile(path, JSON.stringify(ordinary));
    await expect(validatePackage(dir)).rejects.toThrow('仅电视剧');
  });
  it('preserves cover metadata without fetching it and accepts explicitly empty TV seasons', async () => {
    const dir = await packageFor('typed-cover', 'tv');
    const path = resolve(dir, 'book.json'); const b = JSON.parse(await readFile(path, 'utf8'));
    b.seasons = []; b.coverUrl = 'https://covers.invalid/cover.jpg';
    await writeFile(path, JSON.stringify(b));
    await ops.import(dir, 'sample-public', 'typed-test');
    await ops.publish('typed-cover', contentBuild, null, 'typed-test');
    const value = (await get('/v1/books/typed-cover')).body.data;
    expect(value).toMatchObject({ coverUrl: b.coverUrl, seasons: [], contentType: 'tv', unitCount: 3 });
    contract('Book', value);
    expect((await get('/v1/books?contentType=tv')).body.data.items.find((b: any) => b.bookId === 'typed-cover').coverUrl).toBe(b.coverUrl);
  });
});
