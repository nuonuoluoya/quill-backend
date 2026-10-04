import { it, expect } from 'vitest';
import request from 'supertest';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/db.js';
import { Storage } from '../src/storage.js';
import { ImportService, validatePackage } from '../src/importer.js';
import { createApp } from '../src/app.js';
import { projectPath } from '../src/paths.js';
import { playable } from '../contracts/src/index.js';

async function fixture(edit: (b: any, c: any) => void) {
  const path = await mkdtemp(resolve(tmpdir(), 'quill-review-audio-'));
  await cp(projectPath('contracts/fixtures/a-quiet-morning'), path, { recursive: true });
  const b = JSON.parse(await readFile(resolve(path, 'book.json'), 'utf8'));
  const c = JSON.parse(await readFile(resolve(path, 'chapters/c01.json'), 'utf8'));
  b.allowReviewAudio = true;
  c.sentences[0].alignment = { status: 'needs_review', reasons: ['pdf_wording_difference'] };
  edit(b, c);
  await writeFile(resolve(path, 'book.json'), JSON.stringify(b));
  await writeFile(resolve(path, 'chapters/c01.json'), JSON.stringify(c));
  return path;
}

it.each([
  ['missing opt-in', (b: any) => { delete b.allowReviewAudio; }],
  ['false opt-in', (b: any) => { b.allowReviewAudio = false; }],
  ['invalid opt-in type', (b: any) => { b.allowReviewAudio = 'true'; }],
  ['empty review reasons', (_b: any, c: any) => { c.sentences[0].alignment.reasons = []; }],
  ['missing file', (_b: any, c: any) => { c.sentences[0].audio = 'audio/missing.mp3'; }],
  ['incorrect duration', (_b: any, c: any) => { c.sentences[0].duration += 5; }],
  ['excluded audio', (_b: any, c: any) => { c.sentences[0].alignment.status = 'excluded'; }],
  ['unmatched audio', (_b: any, c: any) => { c.sentences[0].alignment.status = 'unmatched'; }],
  ['half-null audio', (_b: any, c: any) => { c.sentences[0].audio = null; }],
] as const)('rejects review audio with %s', async (_name, edit) => {
  await expect(validatePackage(await fixture(edit))).rejects.toThrow();
});

it('explicitly permits real review audio while retaining missing-audio review sentences and reasons', async () => {
  const p = await validatePackage(await fixture(() => {}));
  const [review, , missing] = p.chapters[0].sentences;
  expect(review.alignment).toEqual({ status: 'needs_review', reasons: ['pdf_wording_difference'] });
  expect(review.audio).toBeTruthy();
  expect(missing).toMatchObject({ audio: null, duration: null, alignment: { status: 'needs_review' } });
  expect(playable({ ...review, audioId: 'audio-identity' })).toBe(true);
  expect(playable({ ...missing, audioId: null })).toBe(false);
  expect(playable({ ...review, audioId: 'audio-identity', alignment: { status: 'excluded', reasons: ['excluded'] } })).toBe(false);
});

it('publishes review audio without changing text progress and negotiates legacy/new HTTP counts and playback', async () => {
  const db = new Database('', 'memory://'); await db.migrate();
  const storage = new Storage(await mkdtemp(resolve(tmpdir(), 'quill-review-audio-media-')));
  const server = await createApp(db, storage, false), ops = new ImportService(db, storage);
  const id = 'a-quiet-morning', oldBuild = 'original-speech-v1', nextBuild = 'review-audio-v2';
  try {
    await ops.import(projectPath('contracts/fixtures/a-quiet-morning'), 'private', 'fixture');
    await ops.publish(id, oldBuild, null, 'fixture');
    const user = await server.services.auth.session('fixture', 'review-audio-user');
    await db.query('INSERT INTO book_access(user_id,book_id) VALUES($1,$2)', [user.user.id,id]);
    await server.services.progress.mutate(user.user.id,id,{textRevision:'original-text-v1',sourceBuildId:oldBuild,
      chapterId:'c01',sentenceId:'c01-s0003',preferredSpeed:1,expectedVersion:0,clientMutationId:randomUUID()});
    const before = (await db.query('SELECT * FROM reading_progress')).rows;
    const path = await fixture((_b,c) => {
      c.sentences[2].audio = c.sentences[0].audio; c.sentences[2].duration = c.sentences[0].duration;
    });
    const b = JSON.parse(await readFile(resolve(path,'book.json'),'utf8'));
    b.buildId = nextBuild; b.chapters[0].playableCount++;
    await writeFile(resolve(path,'book.json'),JSON.stringify(b));
    for(const e of b.chapters){
      const cp = resolve(path,e.data), c = JSON.parse(await readFile(cp,'utf8'));
      c.buildId = nextBuild; await writeFile(cp,JSON.stringify(c));
    }
    await ops.import(path,'private','fixture'); await ops.publish(id,nextBuild,oldBuild,'fixture');
    expect((await db.query('SELECT * FROM reading_progress')).rows).toEqual(before);
    await ops.import(projectPath('contracts/fixtures/the-lantern-garden'),'private','fixture');
    await ops.publish('the-lantern-garden','original-speech-v1',null,'fixture');
    await db.query('INSERT INTO book_access(user_id,book_id) VALUES($1,$2)',[user.user.id,'the-lantern-garden']);
    const http = server.app.getHttpServer(), auth = 'Bearer '+user.accessToken;
    const base = `/v1/books/${id}/builds/${nextBuild}`;
    const read = (path: string, capability?: string) => {
      const r = request(http).get(path).set('Authorization',auth);
      return capability ? r.set('X-Quill-Capabilities',capability) : r;
    };
    for(const capability of [undefined,'unknown-capability','review-audio-v10','review-audio-v1']) {
      const enabled = capability === 'review-audio-v1';
      for(const path of [`/v1/books/${id}`,base]){
        const r = await read(path,capability); expect(r.status).toBe(200);
        expect(r.body.data.chapters[0].playableCount).toBe(enabled?8:6);
        expect(r.body.data).not.toHaveProperty('reviewAudioCounts');
        expect(r.headers.vary).toContain('X-Quill-Capabilities');
      }
      const page = await read('/v1/books?audience=member',capability);
      expect(page.body.data.items[0].playableCount).toBe(enabled?24:22);
      expect(page.body.data.items[0]).not.toHaveProperty('reviewAudioCounts');
      const r = await read(base+'/chapters/c01',capability);
      expect(r.status).toBe(200);
      for(const index of [0,2]){
        const s = r.body.data.sentences[index];expect(s.alignment.status).toBe('needs_review');
        expect(playable(s)).toBe(enabled);expect(s.alignment.reasons.length).toBeGreaterThan(0);
      }
    }
    const first = await read('/v1/books?audience=member&limit=1','review-audio-v1');
    expect(first.body.data.nextCursor).toBeTruthy();
    const nextPath='/v1/books?audience=member&limit=1&cursor='+encodeURIComponent(first.body.data.nextCursor);
    expect((await read(nextPath,'review-audio-v1')).status).toBe(200);
    expect((await read(nextPath)).status).toBe(400);
    expect((await read(base+'/chapters/c01','other, review-audio-v1')).body.data.sentences[2].audioId).toBeTruthy();
    const old = await read(`/v1/books/${id}/builds/${oldBuild}/chapters/c01`,'review-audio-v1');
    expect(old.body.data.sentences[2].audioId).toBeNull();
    expect((await request(http).get(base+'/chapters/c01').set('X-Quill-Capabilities','review-audio-v1')).status).toBe(401);
    expect((await request(http).post(base+'/sentences/c01-s0003/playback')).status).toBe(401);
    const grant = await request(http).post(base+'/sentences/c01-s0003/playback').set('Authorization',auth);
    expect(grant.status).toBe(201);
    const u = new URL(grant.body.data.url);
    expect((await request(http).get(u.pathname+u.search).set('Range','bytes=0-15')).status).toBe(206);
    expect((await request(http).get(u.pathname)).status).toBe(403);
    expect((await db.query('SELECT * FROM reading_progress')).rows).toEqual(before);
    expect((await db.query('SELECT * FROM book_access WHERE book_id=$1',[id])).rows).toHaveLength(1);
  } finally { await server.app.close(); await db.close(); }
});