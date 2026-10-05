import { it, expect } from 'vitest';
import request from 'supertest';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Database } from '../src/db.js';
import { Storage } from '../src/storage.js';
import { ImportService, validatePackage } from '../src/importer.js';
import { createApp } from '../src/app.js';
import { projectPath } from '../src/paths.js';

async function fixture(edit: (b: any) => void = () => {}) {
  const path = await mkdtemp(resolve(tmpdir(), 'quill-podcast-parts-'));
  await cp(projectPath('contracts/fixtures/a-quiet-morning'), path, {recursive:true});
  const b = JSON.parse(await readFile(resolve(path,'book.json'),'utf8'));
  b.contentType='podcast'; b.podcastParts=['lesson']; b.allowReviewAudio=true;
  b.episodes=b.chapters.map((c:any,i:number)=>({id:'ep'+c.id,number:i*2+1,title:c.title}));
  for(const [i,e] of b.chapters.entries()) {
    e.episodeId=b.episodes[i].id; e.part='lesson';
    const file=resolve(path,e.data),c=JSON.parse(await readFile(file,'utf8'));
    if(i===0)c.sentences[0].alignment={status:'needs_review',reasons:['asr_disagreement']};
    await writeFile(file,JSON.stringify(c));
  }
  edit(b); await writeFile(resolve(path,'book.json'),JSON.stringify(b)); return path;
}
it.each([
  ['empty', (b:any)=>{b.podcastParts=[];}],
  ['duplicate', (b:any)=>{b.podcastParts=['lesson','lesson'];}],
  ['wrong order', (b:any)=>{b.podcastParts=['lesson','dialogue'];}],
  ['unknown part', (b:any)=>{b.podcastParts=['lecture'];}],
  ['wrong type', (b:any)=>{b.podcastParts='lesson';}],
  ['null', (b:any)=>{b.podcastParts=null;}],
  ['undeclared chapter part', (b:any)=>{b.chapters[0].part='dialogue';}],
  ['non-podcast declaration', (b:any)=>{b.contentType='book';delete b.episodes;for(const e of b.chapters){delete e.episodeId;delete e.part;}}],
] as const)('rejects podcast parts: %s',async (_name,edit)=>{
  await expect(validatePackage(await fixture(edit))).rejects.toThrow();
});
it.each([undefined,['dialogue','lesson'],['lesson'],['dialogue']])('accepts declared or historical parts %j',async parts=>{
  const p=await validatePackage(await fixture(b=>{
    if(parts===undefined)delete b.podcastParts;else b.podcastParts=parts;
    if(parts?.length===1 && parts[0]==='dialogue')for(const e of b.chapters)e.part='dialogue';
  }));
  expect(p.book.podcastParts).toEqual(parts);expect(p.book.episodes.map((e:any)=>e.number)).toEqual([1,3,5]);
});
it('round-trips lesson-only private details without leaking the declaration to list summaries',async()=>{
  const db=new Database('','memory://');await db.migrate();
  const storage=new Storage(await mkdtemp(resolve(tmpdir(),'quill-podcast-parts-media-')));
  const server=await createApp(db,storage,false),ops=new ImportService(db,storage);
  try {
    const path=await fixture(),p=await validatePackage(path),id=p.book.book.id,build=p.book.buildId;
    await ops.import(path,'private','fixture');await ops.publish(id,build,null,'fixture');
    const user=await server.services.auth.session('fixture','podcast-parts-user');
    await db.query('INSERT INTO book_access(user_id,book_id) VALUES($1,$2)',[user.user.id,id]);
    const http=server.app.getHttpServer(),base='/v1/books/'+id;
    for(const capability of [undefined,'review-audio-v1']) {
      const read=(url:string)=>{const q=request(http).get(url).set('Authorization','Bearer '+user.accessToken);return capability?q.set('X-Quill-Capabilities',capability):q;};
      for(const url of [base,base+'/builds/'+build]) {
        const r=await read(url);expect(r.status).toBe(200);expect(r.body.data.podcastParts).toEqual(['lesson']);
        expect(r.body.data.chapters.every((c:any)=>c.part==='lesson')).toBe(true);
        expect(r.body.data.episodes.map((e:any)=>e.number)).toEqual([1,3,5]);
      }
      const list=await read('/v1/books?audience=member&contentType=podcast');expect(list.status).toBe(200);
      expect(list.body.data.items[0]).not.toHaveProperty('podcastParts');
      expect(list.body.data.items[0].episodeCount).toBe(3);
      const count=p.book.chapters.reduce((n:number,c:any)=>n+c.playableCount,0);
      expect(list.body.data.items[0].playableCount).toBe(count-(capability?0:1));
      const chapter=await read(base+'/builds/'+build+'/chapters/c01');expect(chapter.status).toBe(200);
      expect(chapter.body.data.part).toBe('lesson');expect(chapter.body.data.sentences[0].alignment.status).toBe('needs_review');
      expect(Boolean(chapter.body.data.sentences[0].audioId)).toBe(Boolean(capability));
    }
    expect((await request(http).get(base)).status).toBe(401);
    const legacy=await fixture(b=>{delete b.podcastParts;b.book.id='legacy-podcast';});
    // Keep every source chapter identity consistent with this second programme.
    const book=JSON.parse(await readFile(resolve(legacy,'book.json'),'utf8'));
    for(const e of book.chapters){const file=resolve(legacy,e.data),c=JSON.parse(await readFile(file,'utf8'));c.bookId=book.book.id;await writeFile(file,JSON.stringify(c));}
    await ops.import(legacy,'sample-public','fixture');await ops.publish(book.book.id,book.buildId,null,'fixture');
    const old=await request(http).get('/v1/books/legacy-podcast');expect(old.status).toBe(200);expect(old.body.data).not.toHaveProperty('podcastParts');
  } finally {await server.app.close();await db.close();}
});