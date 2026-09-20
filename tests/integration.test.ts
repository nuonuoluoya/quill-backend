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
