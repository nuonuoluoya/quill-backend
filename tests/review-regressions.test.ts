import { it, expect, vi } from 'vitest';
import request from 'supertest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Database } from '../src/db.js';
import { Storage } from '../src/storage.js';
import { ImportService } from '../src/importer.js';
import { createApp } from '../src/app.js';
import { exportSnapshot } from '../src/data-transfer.js';
import { projectPath } from '../src/paths.js';

async function isolated() {
  const db = new Database('', 'memory://');
  await db.migrate();
  const storage = new Storage(await mkdtemp(resolve(tmpdir(), 'quill-review-regression-')));
  return { db, storage, ops: new ImportService(db, storage) };
}

it('shares the login budget across route-equivalent case and trailing-slash variants', async () => {
  const { db, storage } = await isolated();
  const server = await createApp(db, storage, false);
  const frozen = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  try {
    const http = server.app.getHttpServer();
    for (let i = 0; i < 20; i++) {
      const path = i % 2 ? '/V1/AUTH/WECHAT/' : '/v1/auth/wechat';
      expect((await request(http).post(path).send({ code: 42 })).status).toBe(400);
    }
    for (const path of ['/v1/auth/wechat', '/V1/AUTH/WECHAT/', '/v1/Auth/WeChat']) {
      const result = await request(http).post(path).send({ code: 42 });
      expect(result.status).toBe(429);
      expect(result.body.error.code).toBe('RATE_LIMITED');
      expect(Number(result.headers['retry-after'])).toBeGreaterThan(0);
    }
    // Exhausting the login budget must not consume the ordinary API budget.
    expect((await request(http).get('/v1/books')).status).toBe(200);
  } finally {
    frozen.mockRestore();
    await server.app.close();
    await db.close();
  }
});

it('limits business paths containing health and exempts only exact health GET/HEAD routes', async () => {
  const { db, storage, ops } = await isolated();
  await ops.import(projectPath('contracts/fixtures/a-quiet-morning'), 'sample-public', 'test');
  await ops.publish('a-quiet-morning', 'original-speech-v1', null, 'test');
  const server = await createApp(db, storage, false);
  const frozen = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  const query = vi.spyOn(db, 'query');
  try {
    const http = server.app.getHttpServer();
    const path = '/v1/books/a-quiet-morning/builds/health/chapters/c01';
    for (let i = 0; i < 600; i++) expect((await request(http).get(path)).status).toBe(404);
    query.mockClear();
    expect((await request(http).get(path)).status).toBe(429);
    expect(query).not.toHaveBeenCalled();
    for (const route of ['/v1/health/live', '/V1/HEALTH/LIVE/', '/v1/health/ready/']) {
      expect((await request(http).get(route)).status).toBe(200);
      expect((await request(http).head(route)).status).toBe(200);
    }
    for (const method of ['post', 'put', 'delete'] as const)
      expect((await request(http)[method]('/v1/health/live')).status).toBe(429);
    for (const route of ['/v1/health/live/extra', '/v1/health/live//', '/v1/health/not-a-check'])
      expect((await request(http).get(route)).status).toBe(429);
  } finally {
    query.mockRestore();
    frozen.mockRestore();
    await server.app.close();
    await db.close();
  }
});

it.each([
  ['a-quiet-morning', 'sample-public', 'private'],
  ['the-lantern-garden', 'private', 'sample-public'],
] as const)('rejects conflicting repeated visibility for %s without changing any stored state', async (id, initial, conflicting) => {
  const { db, ops } = await isolated();
  try {
    const fixture = projectPath('contracts/fixtures', id);
    const book = JSON.parse(await readFile(resolve(fixture, 'book.json'), 'utf8'));
    await ops.import(fixture, initial, 'test');
    await db.query("INSERT INTO users(id,appid,openid) VALUES('review-user','fixture-app','fixture-openid')");
    await db.query("INSERT INTO book_access(user_id,book_id) VALUES('review-user',$1)", [id]);
    for (const status of ['ready', 'active', 'retained', 'retired', 'revoked']) {
      await db.query("UPDATE book_builds SET status=$3,retain_until=CASE WHEN $3='retained' THEN now()+interval '7 days' ELSE NULL END WHERE book_id=$1 AND build_id=$2", [id, book.buildId, status]);
      await db.query('UPDATE books SET active_build_id=$2 WHERE book_id=$1', [id, status === 'active' ? book.buildId : null]);
      const before = await exportSnapshot(db);
      await expect(ops.import(fixture, conflicting, 'test')).rejects.toThrow('可见性');
      expect(await exportSnapshot(db)).toEqual(before);
      expect(await ops.import(fixture, initial, 'test')).toMatchObject({ reused: true, status });
      expect(await exportSnapshot(db)).toEqual(before);
    }
  } finally {
    await db.close();
  }
});
