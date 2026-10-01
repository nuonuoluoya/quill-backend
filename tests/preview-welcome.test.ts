import { beforeAll, afterAll, afterEach, it, expect, vi } from 'vitest';
import request from 'supertest';
import { mkdtemp, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Ajv } from 'ajv';
import { Database } from '../src/db.js';
import { config } from '../src/config.js';
import { Storage } from '../src/storage.js';
import { ImportService, validatePackage } from '../src/importer.js';
import { prepareFirstChapterPreview } from '../src/preview.js';
import { createApp } from '../src/app.js';
import { projectPath } from '../src/paths.js';
let db: Database, storage: Storage, ops: ImportService, server: Awaited<ReturnType<typeof createApp>>, root: string;
const source='welcome-private', preview='welcome-preview', build='original-speech-v1';
const originalConfig={newUserBookId:config.newUserBookId,appid:config.appid,appSecret:config.appSecret};
beforeAll(async()=>{
 root=await mkdtemp(resolve(tmpdir(),'quill-preview-'));
 db=new Database(process.env.TEST_DATABASE_URL || '', 'memory://'); await db.migrate();
 storage=new Storage(resolve(root,'media'));ops=new ImportService(db,storage);
 const dir=resolve(root,'source');await cp(projectPath('contracts/fixtures/a-quiet-morning'),dir,{recursive:true});
 const book=JSON.parse(await readFile(resolve(dir,'book.json'),'utf8'));book.book.id=source;
 await writeFile(resolve(dir,'book.json'),JSON.stringify(book));
 for(const c of book.chapters){const p=resolve(dir,c.data),chapter=JSON.parse(await readFile(p,'utf8'));chapter.bookId=source;await writeFile(p,JSON.stringify(chapter));}
 await ops.import(dir,'private','test');await ops.publish(source,build,null,'test');
 await ops.import(projectPath('contracts/fixtures/a-quiet-morning'),'private','test');await ops.publish('a-quiet-morning',build,null,'test');
 server=await createApp(db,storage,false);await server.app.init();
});
afterEach(()=>{Object.assign(config,originalConfig);vi.restoreAllMocks();});
afterAll(async()=>{await server?.app.close();await db?.close();});
const grants=async(user:string)=>(await db.query('SELECT * FROM book_access WHERE user_id=$1',[user])).rows;

it('exports only the first chapter, keeps lock metadata separate, enforces anonymous media boundaries',async()=>{
 const dir=resolve(root,'preview');const report=await prepareFirstChapterPreview(db,storage,source,build,preview,dir);
 expect(report).toMatchObject({sentenceCount:8,playableCount:7,copiedAudio:8,lockedChapterCount:2});
 expect(await readdir(resolve(dir,'chapters'))).toEqual(['first.json']);
 expect(await readdir(resolve(dir,'audio'))).toHaveLength(8);
 await ops.import(dir,'sample-public','test');await ops.publish(preview,report.buildId,null,'test');
 const http=server.app.getHttpServer();const detail=await request(http).get('/v1/books/'+preview);
 expect(detail.status).toBe(200);expect(detail.body.data.chapters).toHaveLength(1);
 expect(detail.body.data).toMatchObject({unitCount:1,previewOfBookId:source,contentScope:'sample',visibility:'sample-public'});
 expect(detail.body.data.lockedChapters).toEqual([{id:'c02',title:'By the Window',number:2},{id:'c03',title:'The Walk Home',number:3}]);
 const ajv=new Ajv({strict:false,validateFormats:false});expect(ajv.compile({$ref:'#/components/schemas/Book',components:server.document.components})(detail.body.data)).toBe(true);
 const summary=(await request(http).get('/v1/books?audience=sample')).body.data.items.find((b:any)=>b.bookId===preview);
 expect(summary).toMatchObject({chapterCount:1,unitCount:1});expect(summary).not.toHaveProperty('lockedChapters');expect(summary).not.toHaveProperty('previewOfBookId');
 const base=`/v1/books/${preview}/builds/${report.buildId}`;
 const chapter=(await request(http).get(base+'/chapters/c01')).body.data;
 const old=await server.services.books.chapter(source,build,'c01',null).catch(()=>null);expect(old).toBeNull();
 const sourceChapter=(await db.query('SELECT content FROM chapters WHERE book_id=$1 AND chapter_id=$2',[source,'c01'])).rows[0].content;
 expect(chapter.sentences.map((s:any)=>[s.id,s.text,s.alignment])).toEqual(sourceChapter.sentences.map((s:any)=>[s.id,s.text,s.alignment]));
 expect(chapter.sentences[0].audioId).not.toBe(sourceChapter.sentences[0].audioId);
 expect((await request(http).get(base+'/chapters/c02')).status).toBe(404);
 expect((await request(http).post(base+'/sentences/c02-s0001/playback')).status).toBe(404);
 expect((await request(http).post(base+'/chapters/c02/playback')).status).toBe(404);
 expect((await request(http).get('/v1/books/'+source)).status).toBe(401);
 expect((await request(http).get(`/v1/books/${source}/builds/${build}/chapters/c02`)).status).toBe(401);
 expect((await request(http).post(`/v1/books/${source}/builds/${build}/sentences/c01-s0001/playback`)).status).toBe(401);
 expect((await request(http).post(base+'/sentences/c01-s0003/playback')).status).toBe(422);
 for(const path of ['/sentences/c01-s0001/playback','/chapters/c01/playback']){
  const p=await request(http).post(base+path);expect(p.status).toBe(201);const u=new URL(p.body.data.url);
  expect((await request(http).get(u.pathname+u.search).set('Range','bytes=0-15')).status).toBe(206);
  expect((await request(http).get(u.pathname)).status).toBe(403);
 }
 await expect(prepareFirstChapterPreview(db,storage,source,'wrong-build','bad-preview',resolve(root,'wrong'))).rejects.toThrow('not active');
 await expect(prepareFirstChapterPreview(db,storage,source,build,source,resolve(root,'same'))).rejects.toThrow('distinct');
 await expect(prepareFirstChapterPreview(db,storage,source,build,preview,dir)).rejects.toThrow();
 const p=resolve(dir,'book.json'),b=JSON.parse(await readFile(p,'utf8'));
 for(const change of [(x:any)=>x.lockedChapters[0].id='c01',(x:any)=>x.lockedChapters[0].number=3,(x:any)=>x.lockedChapters[0].text='secret',(x:any)=>delete x.previewOfBookId]){
  const bad=structuredClone(b);change(bad);await writeFile(p,JSON.stringify(bad));await expect(validatePackage(dir)).rejects.toThrow();
 }
 await writeFile(p,JSON.stringify(b));await expect(ops.import(dir,'private','test')).rejects.toThrow('公开样本');
});

it('real WeChat exchange grants only one welcome book to a newly created account',async()=>{
 Object.assign(config,{newUserBookId:source,appid:'test-welcome',appSecret:'test-secret'});
 vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(JSON.stringify({openid:'welcome-new'}),{status:200}));
 const r=await request(server.app.getHttpServer()).post('/v1/auth/wechat').send({code:'valid-test-code'});expect(r.status).toBe(201);
 const user=r.body.data.user.id;expect(await grants(user)).toHaveLength(1);expect((await grants(user))[0]).toMatchObject({book_id:source,expires_at:null,revoked_at:null});
 const repeated=await server.services.auth.login('second-code');expect(repeated.user.id).toBe(user);expect(await grants(user)).toHaveLength(1);
 expect((await db.query("SELECT 1 FROM content_audits WHERE action='new-user-grant' AND details->>'userId'=$1",[user])).rows).toHaveLength(1);
 await expect(server.services.books.current('a-quiet-morning',user)).rejects.toMatchObject({status:403});
});
it('concurrent first login produces a single grant and audit',async()=>{
 config.newUserBookId=source;
 const results=await Promise.all(Array.from({length:4},()=>server.services.auth.session('test-welcome','concurrent',true)));
 expect(new Set(results.map(r=>r.user.id)).size).toBe(1);expect(await grants(results[0].user.id)).toHaveLength(1);
 expect((await db.query("SELECT 1 FROM content_audits WHERE action='new-user-grant' AND details->>'userId'=$1",[results[0].user.id])).rows).toHaveLength(1);
});
it('existing accounts and revoked/expired grants are never backfilled or renewed',async()=>{
 const old=await server.services.auth.session('test-welcome','old');config.newUserBookId=source;
 await server.services.auth.session('test-welcome','old',true);expect(await grants(old.user.id)).toHaveLength(0);
 const fresh=await server.services.auth.session('test-welcome','revoked',true);
 await db.query('UPDATE book_access SET revoked_at=now(),expires_at=now() WHERE user_id=$1',[fresh.user.id]);
 const before=await grants(fresh.user.id);await server.services.auth.session('test-welcome','revoked',true);expect(await grants(fresh.user.id)).toEqual(before);
 await expect(server.services.books.current(source,fresh.user.id)).rejects.toMatchObject({status:403});
 await db.query('UPDATE book_access SET revoked_at=NULL WHERE user_id=$1',[fresh.user.id]);
 const expired=await grants(fresh.user.id);await server.services.auth.session('test-welcome','revoked',true);expect(await grants(fresh.user.id)).toEqual(expired);
 await expect(server.services.books.current(source,fresh.user.id)).rejects.toMatchObject({status:403});
 await db.query('UPDATE users SET disabled=true WHERE id=$1',[fresh.user.id]);
 await expect(server.services.auth.session('test-welcome','revoked',true)).rejects.toThrow('不可用');
});
it('disabled configuration and local sessions do not grant; unavailable target rolls back account and session',async()=>{
 config.newUserBookId='';const a=await server.services.auth.session('test-welcome','disabled-setting',true);expect(await grants(a.user.id)).toHaveLength(0);
 config.newUserBookId=source;const b=await server.services.auth.session('local-development','local-only');expect(await grants(b.user.id)).toHaveLength(0);
 config.newUserBookId='missing-book';await expect(server.services.auth.session('test-welcome','failed',true)).rejects.toThrow('暂不可用');
 expect((await db.query("SELECT 1 FROM users WHERE appid='test-welcome' AND openid='failed'")).rows).toHaveLength(0);
 config.newUserBookId=preview;await expect(server.services.auth.session('test-welcome','public-target',true)).rejects.toThrow('暂不可用');
 expect((await db.query("SELECT 1 FROM users WHERE appid='test-welcome' AND openid='public-target'")).rows).toHaveLength(0);
 // A database failure after inserting the grant must roll back the entire registration.
 config.newUserBookId=source;const original=db.transaction.bind(db);
 vi.spyOn(db,'transaction').mockImplementation(work=>original(tx=>work({query:async(sql,args)=>{if(sql.startsWith('INSERT INTO sessions'))throw Error('session-write-failure');return tx.query(sql,args);}})));
 await expect(server.services.auth.session('test-welcome','rollback',true)).rejects.toThrow('session-write-failure');
 expect((await db.query("SELECT 1 FROM users WHERE appid='test-welcome' AND openid='rollback'")).rows).toHaveLength(0);
});
