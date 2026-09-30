import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { safePath } from '../src/importer.js';

const assert = (ok: unknown, message: string) => { if (!ok) throw Error(message); };
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Copies only reviewed playable audio; the supplied source tree remains untouched. */
export async function prepareEnglishPod(source: string, destination: string, expectedEpisodes = 365) {
  const root = await realpath(source);
  const output = resolve(await realpath(dirname(resolve(destination))), basename(destination));
  const inside = relative(root, output);
  assert(inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside), 'Output must be outside the source directory');
  const folders = (await readdir(root, { withFileTypes: true }))
    .filter(d => d.isDirectory() && /^ep[1-9][0-9]*-en$/.test(d.name))
    .map(d => ({ name: d.name, number: Number(d.name.slice(2, -3)) }))
    .sort((a, b) => a.number - b.number);
  assert(folders.length === expectedEpisodes && folders.every((f, i) => f.number === i + 1),
    `Expected consecutive episodes 1 through ${expectedEpisodes}`);
  await mkdir(output); // Never overwrite a prior package or merge an interrupted run.
  await mkdir(resolve(output, 'chapters'));
  await mkdir(resolve(output, 'audio'));
  const manifest = createHash('sha256').update('englishpod-adapter-v1');
  const book: any = {
    schemaVersion: 2, buildId: '', textRevision: '', contentType: 'podcast', contentScope: 'complete',
    book: { id: 'englishpod-en', title: 'English Pod', language: 'en',
      edition: 'User-supplied EnglishPod; dialogue and teaching; original review states retained' },
    episodes: [], chapters: [],
  };
  const chapters: any[] = [], missing: { number: number; part: string }[] = [];
  let sentences = 0, playable = 0, audioBytes = 0;
  async function sourceFile(folder: string, name: string) {
    const base = await realpath(resolve(root, folder));
    const baseRelative = relative(root, base);
    assert(!isAbsolute(baseRelative) && !baseRelative.startsWith('..' + sep) && baseRelative !== '..', 'Source episode escapes root');
    const path = await realpath(resolve(base, safePath(name)));
    const rel = relative(base, path);
    assert(!isAbsolute(rel) && !rel.startsWith('..' + sep) && rel !== '..', 'Source file escapes episode');
    return readFile(path);
  }
  for (const folder of folders) {
    const sourceBook = JSON.parse((await sourceFile(folder.name, 'book.json')).toString('utf8'));
    assert(sourceBook.schemaVersion === 2 && sourceBook.book.id === folder.name && sourceBook.book.language === 'en', 'Source book identity mismatch');
    assert(['complete', 'partial', 'sample'].includes(sourceBook.contentScope), 'Unknown source scope');
    assert(Array.isArray(sourceBook.chapters) && sourceBook.chapters.length > 0, 'Source episode has no parts');
    manifest.update(JSON.stringify(sourceBook));
    const episodeId = `ep${String(folder.number).padStart(3, '0')}`;
    const title = sourceBook.book.title.replace(/^EnglishPod\s+\d+\s*[—–-]\s*/, '').trim();
    assert(title.length > 0, 'Missing episode title');
    book.episodes.push({ id: episodeId, number: folder.number, title });
    const entries = new Map<string, any>();
    for (const entry of sourceBook.chapters) {
      assert(['c01', 'c02'].includes(entry.id) && !entries.has(entry.id), 'Unknown or duplicate source part');
      entries.set(entry.id, entry);
    }
    for (const [sourceId, kind, part, label] of [['c01', 'dg', 'dialogue', '对话'], ['c02', 'pb', 'lesson', '教学']]) {
      const entry = entries.get(sourceId);
      if (!entry) { missing.push({ number: folder.number, part }); continue; }
      const chapter = JSON.parse((await sourceFile(folder.name, entry.data)).toString('utf8'));
      assert(chapter.schemaVersion === 2 && chapter.bookId === sourceBook.book.id &&
        chapter.buildId === sourceBook.buildId && chapter.textRevision === sourceBook.textRevision &&
        chapter.chapterId === sourceId, 'Source chapter identity mismatch');
      assert(chapter.sentences.length === entry.sentenceCount && Math.abs(chapter.chapterDuration - entry.duration) <= .1, 'Source chapter counts/duration mismatch');
      manifest.update(JSON.stringify(chapter));
      const chapterId = `${episodeId}-${kind}`;
      let partPlayable = 0;
      const seen = new Set<string>();
      for (const [index, sentence] of chapter.sentences.entries()) {
        assert(typeof sentence.id === 'string' && !seen.has(sentence.id) && sentence.index === index + 1, 'Source sentence identity/order mismatch');
        seen.add(sentence.id);
        assert(['verified','auto_passed','needs_review','unmatched','excluded'].includes(sentence.alignment.status), 'Unknown source review status');
        sentence.id = `${episodeId}-${sentence.id}`;
        if (['verified', 'auto_passed'].includes(sentence.alignment.status)) {
          assert(typeof sentence.audio === 'string' && sentence.duration > 0, 'Playable source has no audio');
          const bytes = await sourceFile(folder.name, sentence.audio);
          assert(bytes.length > 0 && bytes.length < 256 * 1024 ** 2, 'Invalid audio size');
          const audio = `audio/${sentence.id}.mp3`;
          safePath(audio);
          await writeFile(resolve(output, audio), bytes, { flag: 'wx' });
          manifest.update(JSON.stringify([audio, bytes.length, digest(bytes)]));
          sentence.audio = audio;
          partPlayable++;
          audioBytes += bytes.length;
        } else {
          assert(sentence.alignment.reasons.some((r: string) => r.trim()), 'Unplayable source must retain review reasons');
          sentence.audio = null;
          sentence.duration = null;
        }
      }
      assert(partPlayable === entry.playableCount, 'Source playable count mismatch');
      sentences += chapter.sentences.length;
      playable += partPlayable;
      assert(!chapter.chapterAudio, 'Adapter does not accept unreviewed full-part audio');
      chapter.bookId = book.book.id; chapter.chapterId = chapterId;
      book.chapters.push({ id: chapterId, episodeId, part, title: label, sentenceCount: chapter.sentences.length,
        playableCount: partPlayable, duration: chapter.chapterDuration, data: `chapters/${chapterId}.json` });
      chapters.push(chapter);
    }
    if (sourceBook.contentScope !== 'complete') book.contentScope = 'sample';
    if (folder.number % 25 === 0) console.log(`Prepared ${folder.number}/${expectedEpisodes} episodes`);
  }
  if (missing.length) book.contentScope = 'sample';
  book.buildId = `englishpod-${manifest.digest('hex').slice(0, 20)}`;
  book.textRevision = `englishpod-text-${digest(JSON.stringify(chapters.map(c => [c.chapterId, c.sentences.map((s: any) => [s.id,s.index,s.text])]))).slice(0, 20)}`;
  for (const chapter of chapters) {
    chapter.buildId = book.buildId; chapter.textRevision = book.textRevision;
    await writeFile(resolve(output, `chapters/${chapter.chapterId}.json`), JSON.stringify(chapter) + '\n');
  }
  await writeFile(resolve(output, 'book.json'), JSON.stringify(book) + '\n');
  const report = { bookId: book.book.id, buildId: book.buildId, textRevision: book.textRevision,
    episodes: book.episodes.length, chapters: chapters.length, sentences, playable, unavailable: sentences - playable, audioBytes, missing };
  await writeFile(resolve(output, 'preparation-report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw Error('Usage: tsx scripts/prepare-englishpod.ts SOURCE NEW_OUTPUT_DIRECTORY');
  console.log(JSON.stringify(await prepareEnglishPod(process.argv[2], process.argv[3]), null, 2));
}
