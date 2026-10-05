import { describe, it, expect } from 'vitest';
import { Database } from '../src/db.js';
import { exportSnapshot, importSnapshot, summary, verifySnapshot, favoriteTables, type LegacySnapshot } from '../src/data-transfer.js';

describe('logical database transfer', () => {
  it('preserves cyclic build references, progress, audit sequence and refuses an occupied database', async () => {
    const source = new Database('', 'memory://'), target = new Database('', 'memory://');
    try {
      await source.migrate(); await target.migrate();
      await source.transaction(async tx => {
        await tx.query("INSERT INTO users(id,appid,openid) VALUES('u','test-app','test-open')");
        await tx.query("INSERT INTO books VALUES('b','private','build')");
        await tx.query("INSERT INTO book_builds(book_id,build_id,text_revision,digest,text_digest,status,metadata) VALUES('b','build','r','d','t','active','{}')");
        await tx.query("INSERT INTO reading_progress(user_id,book_id,text_revision,version,progress) VALUES('u','b','r',9007199254740990,NULL)");
        await tx.query("INSERT INTO content_audits(actor,action,book_id) VALUES('test','import','b')");
      });
      await source.query("INSERT INTO favorite_accounts VALUES('u',9007199254740990)");
      await source.query("INSERT INTO sentence_favorites VALUES('u',$1,'removed-book','old','c','s','retired',now(),9007199254740990)",['a'.repeat(64)]);
      await source.query("INSERT INTO favorite_mutations(user_id,client_mutation_id,digest) VALUES('u','mutation','digest')");
      const snapshot = await exportSnapshot(source);
      await importSnapshot(target, snapshot);
      const restored = await exportSnapshot(target);
      expect(summary(restored)).toEqual(summary(snapshot));
      expect(restored.auditSequence).toEqual(snapshot.auditSequence);
      await expect(importSnapshot(target, snapshot)).rejects.toThrow('must be empty');
      expect(summary(await exportSnapshot(target))).toEqual(summary(snapshot));
      expect((await target.query<{id: number}>("INSERT INTO content_audits(actor,action) VALUES('test','next') RETURNING id")).rows[0].id).toBe(2);
    } finally { await source.close(); await target.close(); }
  });
  it('rolls back all rows when a later row violates a foreign key', async () => {
    const source = new Database('', 'memory://'), target = new Database('', 'memory://');
    try {
      await source.migrate(); await target.migrate();
      const snapshot = await exportSnapshot(source);
      snapshot.tables.users.push({id:'u',appid:'test-app',openid:'test-open',disabled:false,created_at:'2026-01-01T00:00:00+00:00'});
      snapshot.tables.sessions.push({token_hash:'hash',user_id:'missing',expires_at:'2026-01-01T00:00:00+00:00',revoked_at:null,created_at:'2026-01-01T00:00:00+00:00'});
      await expect(importSnapshot(target, snapshot)).rejects.toThrow();
      expect((await target.query('SELECT id FROM users')).rows).toEqual([]);
    } finally { await source.close(); await target.close(); }
  });
});

it('accepts strict legacy v1 snapshots as empty favorites, verifies v2, and rejects extra legacy tables',async()=>{
  const source=new Database('', 'memory://'),target=new Database('', 'memory://');
  try{
    await source.migrate();await target.migrate();
    await source.query("INSERT INTO users(id,appid,openid) VALUES('legacy','a','o')");
    const v2=await exportSnapshot(source);
    const legacy:any=structuredClone(v2);legacy.format='quill-transfer-v1';
    for(const table of favoriteTables){delete legacy.tables[table];delete legacy.columns[table];}
    await importSnapshot(target,legacy as LegacySnapshot);
    const restored=await exportSnapshot(target);
    expect(verifySnapshot(restored,legacy)).toBe(true);expect(verifySnapshot(restored,v2)).toBe(true);
    for(const table of favoriteTables)expect(restored.tables[table]).toEqual([]);
    const invalid=structuredClone(legacy);invalid.tables.favorite_accounts=[];
    await expect(importSnapshot(source,invalid)).rejects.toThrow('Invalid transfer format');
    await target.query("INSERT INTO favorite_accounts VALUES('legacy',0)");
    expect(verifySnapshot(await exportSnapshot(target),legacy)).toBe(false);
    await expect(importSnapshot(target,legacy)).rejects.toThrow('must be empty');
  }finally{await source.close();await target.close();}
});