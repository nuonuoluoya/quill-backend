import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Database } from './db.js';
import { Storage } from './storage.js';
import { sha } from './auth.js';
import { validatePackage } from './importer.js';

/** Operator-only export; creates an independent first-chapter package, never changes source access. */
export async function prepareFirstChapterPreview(
  db: Database, storage: Storage, sourceId: string, expectedBuild: string, targetId: string, directory: string,
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(targetId) || targetId === sourceId)
    throw Error('Preview needs a distinct valid book ID');
  const source = (await db.query(`SELECT v.metadata FROM books b JOIN book_builds v
    ON v.book_id=b.book_id AND v.build_id=b.active_build_id
    WHERE b.book_id=$1 AND b.active_build_id=$2 AND b.visibility='private' AND v.status='active'`,
    [sourceId, expectedBuild])).rows[0]?.metadata;
  if (!source || (source.contentType ?? 'book') !== 'book' || !source.chapters.length)
    throw Error('Expected private source book/build is not active');
  const entry = source.chapters[0];
  const chapter = (await db.query('SELECT content FROM chapters WHERE book_id=$1 AND build_id=$2 AND chapter_id=$3',
    [sourceId, expectedBuild, entry.id])).rows[0]?.content;
  if (!chapter || chapter.bookId !== sourceId || chapter.buildId !== expectedBuild || chapter.chapterId !== entry.id)
    throw Error('Source chapter identity mismatch');
  const assets = (await db.query('SELECT * FROM audio_assets WHERE book_id=$1 AND build_id=$2 AND chapter_id=$3 ORDER BY audio_id',
    [sourceId, expectedBuild, entry.id])).rows;
  const byId = new Map(assets.map(a => [a.audio_id, a]));
  const copied = new Set<string>();
  const lockedChapters = source.chapters.slice(1).map((c: any, i: number) => ({id:c.id,title:c.title,number:i+2}));
  const signature = sha(JSON.stringify({sourceId, expectedBuild, targetId, chapter, lockedChapters,
    assets:assets.map(a => [a.audio_id,a.hash,a.bytes])})).slice(0,24);
  const buildId = `first-chapter-${signature}`;
  const textRevision = `preview-text-${sha(JSON.stringify([targetId,entry.id,chapter.sentences.map((s:any)=>[s.id,s.index,s.text])])).slice(0,24)}`;
  // mkdir without recursive/exist_ok intentionally refuses an existing output directory.
  const root = resolve(directory);
  await mkdir(root);
  await mkdir(resolve(root,'audio'));
  await mkdir(resolve(root,'chapters'));
  async function audio(audioId: string, kind: string, sentenceId: string | null) {
    const asset = byId.get(audioId);
    if (!asset || asset.kind !== kind || (asset.sentence_id ?? null) !== sentenceId)
      throw Error('Audio reference escaped the selected first chapter');
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.stream(asset.object_key)) chunks.push(Buffer.from(chunk));
    const data = Buffer.concat(chunks);
    if (data.length !== Number(asset.bytes) || sha(data) !== asset.hash) throw Error('Source media integrity mismatch');
    const name = `audio/${audioId}.mp3`;
    if (!copied.has(audioId)) await writeFile(resolve(root,name),data,{flag:'wx'});
    copied.add(audioId);
    return name;
  }
  const sentences = [];
  for (const s of chapter.sentences) {
    const allowed = ['verified','auto_passed'].includes(s.alignment.status) && s.audioId;
    sentences.push({id:s.id,index:s.index,text:s.text,...(s.sourceText ? {sourceText:s.sourceText} : {}),
      alignment:s.alignment, duration:allowed ? s.duration : null,
      audio:allowed ? await audio(s.audioId,'sentence',s.id) : null});
  }
  const ca = chapter.chapterAudio;
  const chapterAudio = ca?.status === 'available'
    ? {status:'available',audio:await audio(ca.audioId,'chapter',null),duration:ca.duration,reasons:[]}
    : {status:'unavailable',audio:null,duration:null,reasons:ca?.reasons ?? ['本章全文音频暂不可用']};
  const outChapter = {schemaVersion:2,bookId:targetId,buildId,textRevision,chapterId:entry.id,
    chapterDuration:chapter.chapterDuration,chapterAudio,sentences};
  const book = {schemaVersion:2,buildId,textRevision,contentType:'book',contentScope:'sample',
    book:{id:targetId,title:`${source.title} · 第一章预览`,language:source.language,edition:'第一章公开预览'},
    previewOfBookId:sourceId,lockedChapters,
    chapters:[{id:entry.id,title:entry.title,sentenceCount:sentences.length,
      playableCount:sentences.filter(s=>s.audio).length,duration:entry.duration,data:'chapters/first.json'}]};
  await writeFile(resolve(root,'chapters/first.json'),JSON.stringify(outChapter,null,2)+'\n');
  await writeFile(resolve(root,'book.json'),JSON.stringify(book,null,2)+'\n');
  const checked = await validatePackage(root);
  const report = {sourceId,sourceBuildId:expectedBuild,sourceChapterId:entry.id,bookId:targetId,buildId,textRevision,
    sentenceCount:sentences.length,playableCount:book.chapters[0].playableCount,lockedChapterCount:lockedChapters.length,
    copiedAudio:copied.size,digest:checked.digest};
  await writeFile(resolve(root,'preparation-report.json'),JSON.stringify(report,null,2)+'\n');
  return report;
}
