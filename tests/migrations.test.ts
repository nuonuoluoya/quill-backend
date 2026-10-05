import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/db.js';
import { projectPath } from '../src/paths.js';
it('upgrades an existing 001 database and safely repeats ordered migrations without losing rows',async()=>{
  const path=await mkdtemp(join(tmpdir(),'quill-migration-upgrade-'));
  const original=new PGlite(path);
  await original.exec(await readFile(projectPath('migrations/001-initial.sql'),'utf8'));
  await original.query("INSERT INTO users(id,appid,openid) VALUES('existing','a','o')");await original.close();
  const db=new Database('',path);
  try{
    await db.migrate();await db.query("INSERT INTO favorite_accounts VALUES('existing',5)");await db.migrate();
    expect((await db.query("SELECT version::text FROM favorite_accounts WHERE user_id='existing'")).rows).toEqual([{version:'5'}]);
    expect((await db.query('SELECT id FROM users')).rows).toEqual([{id:'existing'}]);
    await expect(db.query("UPDATE favorite_accounts SET version=9007199254740992")).rejects.toThrow();
  }finally{await db.close();}
});