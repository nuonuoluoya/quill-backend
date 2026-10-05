import { beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';
import request from 'supertest';
import { Ajv } from 'ajv';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/db.js';
import { Storage } from '../src/storage.js';
import { createApp } from '../src/app.js';
import { FavoritesService, favoriteId, favoritePageSql } from '../src/favorites.js';
import { sha } from '../src/auth.js';

const db = new Database('', 'memory://');
const favorites = new FavoritesService(db);
let server: Awaited<ReturnType<typeof createApp>>;
const token='local-favorites-test-token-'.padEnd(48,'x');
const mutation=()=>({clientMutationId:randomUUID(),clientMutationCreatedAt:new Date().toISOString()});
const ref=(sentenceId='s1')=>({bookId:'b',textRevision:'r',chapterId:'c',sentenceId});
const put=(sentenceId='s1')=>({...ref(sentenceId),sourceBuildId:'v',...mutation()});
const status=(sentenceIds=['s1'])=>({bookId:'b',textRevision:'r',chapterId:'c',sourceBuildId:'v',sentenceIds});
const sentence=(id:string,index:number)=>({id,index,text:`Hello ${id} 100%_true`,audioId:sha(id),duration:1,
  alignment:{status:index===2?'needs_review':'verified',reasons:index===2?['fixture']:[]}});

beforeAll(async()=>{
  await db.migrate();
  await db.query("INSERT INTO users(id,appid,openid) VALUES('u','test','one'),('other','test','two')");
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,'u',now()+interval '2 hours')",[sha(token)]);
  await db.transaction(async tx=>{
    await tx.query("INSERT INTO books VALUES('b','private','v')");
    await tx.query(`INSERT INTO book_builds(book_id,build_id,text_revision,digest,text_digest,status,metadata)
      VALUES('b','v','r','d','t','active',$1)`,[JSON.stringify({title:'Synthetic Podcast',contentType:'podcast',episodes:[{id:'e',title:'Episode One',number:1}]})]);
    await tx.query(`INSERT INTO chapters VALUES('b','v','c',1,$1,'{}')`,[JSON.stringify({title:'Lesson',episodeId:'e',part:'lesson'})]);
    for(let i=1;i<=4;i++)await tx.query(`INSERT INTO sentences VALUES('b','v','c',$1,$2,$3)`,['s'+i,i,JSON.stringify(sentence('s'+i,i))]);
  });
  server=await createApp(db,new Storage(await mkdtemp(join(tmpdir(),'quill-favorite-media-'))),false);
  await server.app.init();
},30000);
beforeEach(async()=>{
  await db.query('TRUNCATE favorite_mutations,sentence_favorites,favorite_accounts');
  await db.query("UPDATE book_builds SET text_revision='r',status='active' WHERE book_id='b' AND build_id='v'");
  await db.query("UPDATE books SET active_build_id='v' WHERE book_id='b'");
  await db.query("DELETE FROM sentences WHERE sentence_id LIKE 'bulk-%'");
  await db.query("INSERT INTO book_access(user_id,book_id) VALUES('u','b') ON CONFLICT(user_id,book_id) DO UPDATE SET revoked_at=NULL,expires_at=NULL,starts_at=now()");
});
afterAll(async()=>{await server?.app.close();await db.close();});

it('returns current truth for retries, preserves duplicates, and serializes competing changes',async()=>{
  const initial=put();const a=await favorites.put('u',initial);
  expect(a).toMatchObject({favoriteId:favoriteId(ref()),saved:true,version:1});
  expect(await favorites.put('u',put())).toEqual(a);
  const del=mutation();const removed=await favorites.delete('u',a.favoriteId,del);
  expect(removed).toMatchObject({saved:false,favoritedAt:null,version:2});
  expect(await favorites.put('u',initial)).toEqual(removed);
  const again=await favorites.put('u',put());
  expect(again.version).toBe(3);expect(again.favoritedAt).not.toBe(a.favoritedAt);
  expect(await favorites.delete('u',a.favoriteId,del)).toEqual(again);
  await expect(favorites.put('u',{...initial,sentenceId:'s2'})).rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REUSED'});
  const result=await Promise.all([favorites.put('u',put('s2')),favorites.put('u',put('s3'))]);
  expect(result.map(r=>r.version).sort()).toEqual([4,5]);
  expect((await db.query('SELECT * FROM reading_progress')).rows).toEqual([]);
});
it('rejects stale/new future mutations; known retries survive time checks; GC cannot resurrect old writes',async()=>{
  for(const delta of [-25*3600000,6*60000])await expect(favorites.put('u',{...put(),clientMutationCreatedAt:new Date(Date.now()+delta).toISOString()})).rejects.toMatchObject({code:'FAVORITE_MUTATION_EXPIRED'});
  await favorites.put('u',put());
  const old={...put(),clientMutationCreatedAt:new Date(Date.now()-31*86400000).toISOString()};
  await db.query("INSERT INTO favorite_mutations(user_id,client_mutation_id,digest,created_at) VALUES('u',$1,$2,now()-interval '31 days')",[old.clientMutationId,sha(JSON.stringify({method:'put',favoriteId:favoriteId(ref()),...old}))]);
  expect((await favorites.put('u',old)).saved).toBe(true);
  await db.query("DELETE FROM favorite_mutations WHERE created_at<now()-interval '30 days'");
  await expect(favorites.put('u',old)).rejects.toMatchObject({code:'FAVORITE_MUTATION_EXPIRED'});
});
it('counts the whole matching set, treats search literally, and negotiates review audio',async()=>{
  await db.query(`UPDATE sentences SET content=jsonb_set(jsonb_set(content,'{audioId}','null'),'{duration}','null') WHERE sentence_id='s3'`);
  for(let i=1;i<=3;i++)await favorites.put('u',put('s'+i));
  const page=await favorites.list('u',{limit:1,q:' HELLO '});
  expect(page).toMatchObject({totalCount:3,matchedCount:3,playableCount:1,version:3});
  expect(page.items).toHaveLength(1);expect(page.nextCursor).toBeTruthy();
  expect(page.items[0]).toMatchObject({reference:ref('s3'),source:{bookTitle:'Synthetic Podcast',episodeTitle:'Episode One',episodeNumber:1,seasonTitle:null,part:'lesson'},playable:false});
  expect((await favorites.list('u',{q:'%_TRUE'},true)).matchedCount).toBe(3);
  expect((await favorites.list('u',{q:'%_'},true)).playableCount).toBe(2);
  expect((await favorites.list('u',{q:'does not exist'}))).toMatchObject({totalCount:3,matchedCount:0,playableCount:0,items:[]});
  const review=await favorites.get('u',favoriteId(ref('s2')));
  expect(review.sentence).toMatchObject({audioId:null,duration:null});expect(review.playable).toBe(false);
  expect((await favorites.get('u',review.favoriteId,true)).playable).toBe(true);
});
it('binds cursors to account, query, capability and collection version without OFFSET',async()=>{
  for(let i=1;i<=3;i++)await favorites.put('u',put('s'+i));
  const first=await favorites.list('u',{limit:1});
  const second=await favorites.list('u',{limit:1,cursor:first.nextCursor});
  expect(second.items[0].reference?.sentenceId).toBe('s2');
  for(const [user,q,cap] of [['other','',false],['u','Hello',false],['u','',true]] as const)
    await expect(favorites.list(user,{q,cursor:first.nextCursor},cap)).rejects.toMatchObject({code:'INVALID_REQUEST'});
  await expect(favorites.list('u',{cursor:first.nextCursor+'broken'})).rejects.toMatchObject({code:'INVALID_REQUEST'});
  await favorites.delete('u',favoriteId(ref('s1')),mutation());
  await expect(favorites.list('u',{cursor:first.nextCursor})).rejects.toMatchObject({code:'FAVORITES_CHANGED'});
});
it('redacts all private identity and text before revision disclosure, and allows cancellation',async()=>{
  const a=await favorites.put('u',put());
  await db.query("UPDATE book_access SET revoked_at=now() WHERE user_id='u'");
  await db.query("UPDATE book_builds SET text_revision='new' WHERE book_id='b'");
  const redacted=await favorites.get('u',a.favoriteId,true);
  expect(redacted).toEqual({favoriteId:a.favoriteId,favoritedAt:a.favoritedAt,status:'forbidden',reference:null,resolvedBuildId:null,sentence:null,source:null,playable:false});
  expect((await favorites.list('u',{q:'Hello'}))).toMatchObject({totalCount:1,matchedCount:0,playableCount:0,items:[]});
  await db.query("UPDATE book_access SET revoked_at=NULL WHERE user_id='u'");
  expect(await favorites.get('u',a.favoriteId)).toMatchObject({status:'text_revision_changed',reference:null,sentence:null,source:null});
  await db.query("UPDATE books SET active_build_id=NULL WHERE book_id='b'");
  expect(await favorites.get('u',a.favoriteId)).toMatchObject({status:'content_unavailable',reference:null});
  expect(await favorites.delete('u',a.favoriteId,mutation())).toMatchObject({saved:false,version:2});
  expect(await favorites.delete('u',a.favoriteId,mutation())).toMatchObject({saved:false,version:2});
});
it('resolves same-text active builds and blocks adding an obsolete revision',async()=>{
  const a=await favorites.put('u',put());
  await db.transaction(async tx=>{
    await tx.query("UPDATE book_builds SET status='retained',retain_until=now()+interval '1 day' WHERE build_id='v'");
    await tx.query(`INSERT INTO book_builds(book_id,build_id,text_revision,digest,text_digest,status,metadata) SELECT book_id,'next',text_revision,digest,text_digest,'active',metadata FROM book_builds WHERE build_id='v'`);
    await tx.query("INSERT INTO chapters SELECT book_id,'next',chapter_id,sort_order,entry,content FROM chapters WHERE build_id='v'");
    await tx.query("INSERT INTO sentences SELECT book_id,'next',chapter_id,sentence_id,sentence_index,content FROM sentences WHERE build_id='v'");
    await tx.query("UPDATE books SET active_build_id='next' WHERE book_id='b'");
  });
  try {
    expect(await favorites.get('u',a.favoriteId)).toMatchObject({status:'available',resolvedBuildId:'next'});
    await db.query("UPDATE book_builds SET text_revision='new' WHERE build_id='next'");
    await expect(favorites.put('u',put('s2'))).rejects.toMatchObject({code:'FAVORITE_TEXT_REVISION_CHANGED'});
    await db.query("UPDATE book_builds SET status='retired' WHERE build_id='v'");
    await expect(favorites.put('u',put('s2'))).rejects.toMatchObject({code:'BUILD_RETIRED'});
  }finally{
    await db.query("UPDATE books SET active_build_id='v' WHERE book_id='b'");
    await db.query("DELETE FROM sentences WHERE build_id='next'");await db.query("DELETE FROM chapters WHERE build_id='next'");await db.query("DELETE FROM book_builds WHERE build_id='next'");
  }
});
it('validates batch ownership, unique IDs and strict mutation input; isolates accounts',async()=>{
  await favorites.put('u',put());
  expect(await favorites.status('u',status(['s1','s2']))).toEqual({version:1,states:[{sentenceId:'s1',favoriteId:favoriteId(ref()),saved:true},{sentenceId:'s2',favoriteId:favoriteId(ref('s2')),saved:false}]});
  await expect(favorites.status('u',status(['s1','s1']))).rejects.toMatchObject({code:'INVALID_REQUEST'});
  await expect(favorites.status('u',status(Array.from({length:201},(_,i)=>'s'+i)))).rejects.toMatchObject({code:'INVALID_REQUEST'});
  await expect(favorites.status('u',status(['missing']))).rejects.toMatchObject({code:'FAVORITE_INVALID'});
  await expect(favorites.put('u',{...put(),userId:'other'})).rejects.toMatchObject({code:'INVALID_REQUEST'});
  await expect(favorites.put('u',{...put(),chapterId:'elsewhere'})).rejects.toMatchObject({code:'FAVORITE_INVALID'});
  await expect(favorites.get('other',favoriteId(ref()))).rejects.toMatchObject({code:'FAVORITE_NOT_FOUND'});
  expect(await favorites.delete('other',favoriteId(ref()),mutation())).toMatchObject({saved:false,version:0});
  expect((await favorites.get('u',favoriteId(ref()))).status).toBe('available');
});
it('serves all five authenticated HTTP routes with 200, no-store/Vary and transient 503',async()=>{
  const http=server.app.getHttpServer(),base='/v1/me/favorites',auth='Bearer '+token;
  await request(http).get(base).expect(401);
  const added=await request(http).put(base).set('Authorization',auth).send(put()).expect(200);
  const page=await request(http).get(base).set('Authorization',auth).expect(200);
  const ajv=new Ajv({strict:false,validateFormats:false});
  const valid=(name:string,value:unknown)=>ajv.compile({$ref:`#/components/schemas/${name}`,components:server.document.components})(value);
  expect(valid('FavoriteWriteResult',added.body.data)).toBe(true);
  expect(valid('FavoritePage',page.body.data)).toBe(true);
  await db.query("UPDATE book_access SET revoked_at=now() WHERE user_id='u'");
  expect(valid('FavoriteItem',await favorites.get('u',added.body.data.favoriteId))).toBe(true);
  await db.query("UPDATE book_access SET revoked_at=NULL WHERE user_id='u'");
  expect(page.headers['cache-control']).toBe('private, no-store');expect(page.headers.vary).toContain('X-Quill-Capabilities');
  await request(http).get(base+'/'+added.body.data.favoriteId).set('Authorization',auth).expect(200);
  await request(http).post(base+'/status').set('Authorization',auth).send(status()).expect(200);
  await request(http).delete(base+'/'+added.body.data.favoriteId).set('Authorization',auth).send(mutation()).expect(200);
  const broken=vi.spyOn(server.services.favorites,'list').mockRejectedValue(new Error('internal private data'));
  const unavailable=await request(http).get(base).set('Authorization',auth).expect(503);
  expect(unavailable.body.error.code).toBe('SERVICE_UNAVAILABLE');expect(JSON.stringify(unavailable.body)).not.toContain('private data');broken.mockRestore();
});

it('handles 10,000 favorites with one SQL snapshot, accurate counts, cap and indexed pagination',async()=>{
  await db.query(`INSERT INTO sentences SELECT 'b','v','c','bulk-'||i,i+10,
    jsonb_build_object('id','bulk-'||i,'index',i+10,'text','Needle '||i,'audioId',NULL,'duration',NULL,'alignment',jsonb_build_object('status','needs_review','reasons','[]'::jsonb)) FROM generate_series(1,9999) i`);
  await favorites.put('u',put());
  await db.query("INSERT INTO books VALUES('forbidden-bulk','private',NULL)");
  const rows=Array.from({length:9999},(_,i)=>{
    const n=i+1,bookId=n%4===2?'forbidden-bulk':n%4===3?'missing-bulk':'b',textRevision=n%4===1?'old':'r';
    const r={...ref('bulk-'+n),bookId,textRevision};
    return {id:favoriteId(r),sid:r.sentenceId,bid:bookId,revision:textRevision,v:i+2};
  });
  await db.query(`INSERT INTO sentence_favorites SELECT 'u',x.id,x.bid,x.revision,'c',x.sid,'v',now(),x.v FROM jsonb_to_recordset($1::jsonb) AS x(id text,sid text,bid text,revision text,v bigint)`,[JSON.stringify(rows)]);
  await db.query("UPDATE favorite_accounts SET version=10000 WHERE user_id='u'");
  await db.query('ANALYZE');
  const spy=vi.spyOn(db,'query');const times=[];
  for(let i=0;i<3;i++){const start=performance.now();const page=await favorites.list('u',{limit:50});times.push(performance.now()-start);expect(page).toMatchObject({totalCount:10000,matchedCount:10000,playableCount:1});expect(page.items).toHaveLength(50);}
  expect(spy).toHaveBeenCalledTimes(3);spy.mockRestore();
  expect(await favorites.list('u',{q:'needle 9996'})).toMatchObject({totalCount:10000,matchedCount:1,playableCount:0});
  expect(await favorites.list('u',{q:'needle'})).toMatchObject({totalCount:10000,matchedCount:2499});
  const batch=await favorites.status('u',status(Array.from({length:200},(_,i)=>'bulk-'+(i+1))));expect(batch.states).toHaveLength(200);
  await expect(favorites.put('u',put('s4'))).rejects.toMatchObject({code:'FAVORITES_LIMIT_REACHED'});
  expect((await favorites.put('u',put())).version).toBe(10000);
  await db.query('ANALYZE');
  const explain=(await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+favoritePageSql,['u','',false,100,51,null])).rows;
  const last=(await db.query(favoritePageSql,['u','',false,20,51,null])).rows[0];expect(last.items).toHaveLength(19);
  await favorites.delete('u',favoriteId(ref()),mutation());expect((await favorites.put('u',put('s4'))).version).toBe(10002);
  const report={engine:'PGlite / PostgreSQL WASM, isolated synthetic fixture; not production timings',favorites:10000,statusCounts:{available:2500,forbidden:2500,text_revision_changed:2500,content_unavailable:2500},listLimit:50,timesMs:times,explain};
  await writeFile(join(tmpdir(),'quill-favorites-performance.json'),JSON.stringify(report,null,2));
  console.log('Favorites 10k local list ms:',times.map(n=>n.toFixed(1)).join(', '));
},30000);