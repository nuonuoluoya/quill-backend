import 'reflect-metadata';
import { it, expect, vi } from 'vitest';
import request from 'supertest';
vi.mock('../src/config.js', () => ({production:true, config:{trustedProxy:'loopback',corsOrigin:'https://codingluke.site',mediaRoot:'unused',s3:{}}}));
import { createApp } from '../src/app.js';
import type { Database } from '../src/db.js';
import type { Storage } from '../src/storage.js';
it('production startup does not migrate and validates readiness against the database', async () => {
  const db={migrate:vi.fn().mockRejectedValue(new Error('DDL must not run')),query:vi.fn().mockResolvedValue({rows:[]})};
  vi.stubEnv('READY_TOKEN','test-ready-token');
  const server=await createApp(db as unknown as Database,{} as Storage);
  try {
    await server.app.init();
    expect(db.migrate).not.toHaveBeenCalled();
    expect((await request(server.app.getHttpServer()).get('/v1/health/ready')).status).toBe(403);
    expect((await request(server.app.getHttpServer()).get('/v1/health/ready').set('Authorization','Bearer test-ready-token')).status).toBe(200);
    expect(db.query).toHaveBeenCalledWith('SELECT 1');
    const adapter=server.app.getHttpAdapter().getInstance();
    expect(adapter.get('trust proxy fn')('127.0.0.1',0)).toBe(true);
    expect(adapter.get('trust proxy fn')('203.0.113.1',0)).toBe(false);
  } finally {await server.app.close();vi.unstubAllEnvs();}
});
