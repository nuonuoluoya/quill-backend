import { it, expect } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { prepareEnglishPod } from '../scripts/prepare-englishpod.js';
import { validatePackage } from '../src/importer.js';
import { projectPath } from '../src/paths.js';

it('adapts separate podcast packages without mutating source or opening review audio', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'quill-podcast-adapter-'));
  const source = resolve(root, 'source'); await mkdir(source);
  for (const n of [1,2]) {
    const dir=resolve(source,`ep${n}-en`);
    await cp(projectPath('contracts/fixtures/a-quiet-morning'),dir,{recursive:true});
    const b=JSON.parse(await readFile(resolve(dir,'book.json'),'utf8'));
    b.book.id=`ep${n}-en`; b.book.language='en'; b.book.title=`EnglishPod ${n} — Topic ${n}`;
    b.chapters=b.chapters.slice(n===1?0:1,2); b.contentScope=n===1?'complete':'partial';
    for (const e of b.chapters) {
      const path=resolve(dir,e.data); const c=JSON.parse(await readFile(path,'utf8'));
      c.bookId=b.book.id; delete c.chapterAudio;
      if (n===1 && e.id==='c01') {
        c.sentences[0].alignment={status:'needs_review',reasons:['source_uncertain']}; e.playableCount--;
      }
      await writeFile(path,JSON.stringify(c));
    }
    await writeFile(resolve(dir,'book.json'),JSON.stringify(b));
  }
  const original=await readFile(resolve(source,'ep1-en/chapters/c01.json'),'utf8');
  const output=resolve(root,'output');
  const result=await prepareEnglishPod(source,output,2);
  expect(result).toMatchObject({episodes:2,chapters:3,missing:[{number:2,part:'dialogue'}]});
  const validated=await validatePackage(output);
  expect(validated.book).toMatchObject({contentType:'podcast',contentScope:'sample',book:{id:'englishpod-en'}});
  expect(validated.chapters[0].sentences[0]).toMatchObject({id:'ep001-c01-s0001',audio:null,duration:null,alignment:{status:'needs_review'}});
  const all=validated.chapters.flatMap(c=>c.sentences.map((s:any)=>s.id));
  expect(new Set(all).size).toBe(all.length);
  expect(await readFile(resolve(source,'ep1-en/chapters/c01.json'),'utf8')).toBe(original);
  await expect(prepareEnglishPod(source,output,2)).rejects.toThrow();
  await expect(prepareEnglishPod(source,resolve(source,'nested'),2)).rejects.toThrow('outside');
  const second=await prepareEnglishPod(source,resolve(root,'output2'),2);
  expect(second.buildId).toBe(result.buildId); expect(second.textRevision).toBe(result.textRevision);
});
