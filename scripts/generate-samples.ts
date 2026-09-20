import { projectPath } from '../src/paths.js';
/** Development-only fixture authoring. Playback never requires SAPI or FFmpeg. */
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseBuffer } from 'music-metadata';
const ffmpeg = process.argv[2];
if (!ffmpeg) throw Error('Pass the path to FFmpeg');
const data = [
  {
    id: 'a-quiet-morning',
    title: 'A Quiet Morning',
    chapters: [
      [
        'A New Day',
        [
          'The morning light filled the room.',
          'A little bird was singing outside.',
          'I opened the window and listened.',
          'The air was cool and fresh.',
          'It was a quiet beginning.',
          'A cup of tea waited on the table.',
          'I picked up my book and sat down.',
          'There was no need to hurry today.',
        ],
      ],
      [
        'By the Window',
        [
          'A small garden lay beyond the window.',
          'Rain had left tiny drops on the leaves.',
          'The old tree moved gently in the breeze.',
          'I watched a butterfly rest on a flower.',
          'Somewhere nearby, a door opened.',
          'A neighbour walked past with a friendly smile.',
          'I smiled back and turned the page.',
          'The story was just beginning.',
        ],
      ],
      [
        'The Walk Home',
        [
          'In the afternoon I went for a walk.',
          'The path followed a narrow stream.',
          'I could hear water moving over stones.',
          'Two children were flying a bright kite.',
          'The kite rose above the green fields.',
          'Soon the sun began to set.',
          'I followed the path back to my door.',
          'The quiet morning had become a lovely day.',
        ],
      ],
    ],
  },
  {
    id: 'the-lantern-garden',
    title: 'The Lantern Garden',
    chapters: [
      [
        'A Light in the Garden',
        [
          'Mira found a small lantern by the gate.',
          'Its glass was blue and its handle was warm.',
          'She carried it carefully into the garden.',
          'A narrow path appeared between the flowers.',
          'At the end of the path stood an old bench.',
          'Someone had left a letter on the seat.',
          'Mira opened it and began to read.',
          'The message invited her to stay for tea.',
        ],
      ],
      [
        'An Unexpected Guest',
        [
          'A gentle knock came from the garden wall.',
          'Mira looked up from the letter.',
          'A traveller stood beside a wooden door.',
          'He held a basket of fresh apples.',
          'She welcomed him with a smile.',
          'They sat beneath the branches of a pear tree.',
          'The lantern shone softly as they talked.',
          'Evening arrived without either of them noticing.',
        ],
      ],
      [
        'Home Before Dark',
        [
          'The traveller thanked Mira for the tea.',
          'He left one apple beside the blue lantern.',
          'Then he followed the path towards the village.',
          'Mira watched until the trees hid him from view.',
          'She took the lantern back to the gate.',
          'Its warm light touched the old stone wall.',
          'Tomorrow she would return to the garden.',
          'For now, it was time to go home.',
        ],
      ],
    ],
  },
];
for (const b of data) {
  const root = projectPath('contracts/fixtures', b.id);
  await mkdir(resolve(root, 'chapters'), { recursive: true });
  await mkdir(resolve(root, 'audio'), { recursive: true });
  const buildId = 'original-speech-v1',
    textRevision = 'original-text-v1';
  const entries = [];
  async function audio(name: string, text: string) {
    const base = resolve(root, 'audio', name),
      txt = base + '.txt',
      wav = base + '.wav',
      mp3 = base + '.mp3';
    await writeFile(txt, text, 'utf8');
    const speech = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        resolve('scripts/speak.ps1'),
        '-TextPath',
        txt,
        '-OutputPath',
        wav,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (speech.status) throw Error(speech.stderr || speech.stdout);
    const encode = spawnSync(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        wav,
        '-ar',
        '44100',
        '-ac',
        '1',
        '-codec:a',
        'libmp3lame',
        '-b:a',
        '64k',
        mp3,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (encode.status) throw Error(encode.stderr);
    await unlink(txt);
    await unlink(wav);
    const meta = await parseBuffer(
      await readFile(mp3),
      { mimeType: 'audio/mpeg' },
      { duration: true },
    );
    return { audio: `audio/${name}.mp3`, duration: meta.format.duration! };
  }
  for (const [n, [title, texts]] of b.chapters.entries()) {
    const id = `c${String(n + 1).padStart(2, '0')}`,
      full = await audio(id + '-full', (texts as string[]).join(' '));
    const sentences = [];
    for (const [i, text] of (texts as string[]).entries()) {
      const missing = n === 0 && i === 2;
      const a = missing ? { audio: null, duration: null } : await audio(id + '-s' + (i + 1), text);
      sentences.push({
        id: `${id}-s${String(i + 1).padStart(4, '0')}`,
        index: i + 1,
        text,
        ...a,
        alignment: {
          status: missing ? 'needs_review' : 'verified',
          reasons: missing ? ['待复核 · 暂无逐句音频'] : [],
        },
      });
    }
    const chapter = {
      schemaVersion: 2,
      bookId: b.id,
      buildId,
      textRevision,
      chapterId: id,
      chapterDuration: full.duration,
      chapterAudio: { status: 'available', ...full, reasons: [] },
      sentences,
    };
    await writeFile(
      resolve(root, 'chapters', id + '.json'),
      JSON.stringify(chapter, null, 2) + '\n',
    );
    entries.push({
      id,
      title,
      sentenceCount: sentences.length,
      playableCount: sentences.filter((s) => s.audio).length,
      duration: full.duration,
      data: `chapters/${id}.json`,
    });
  }
  await writeFile(
    resolve(root, 'book.json'),
    JSON.stringify(
      {
        schemaVersion: 2,
        buildId,
        textRevision,
        contentScope: 'sample',
        book: { id: b.id, title: b.title, language: 'en-GB', edition: '原创语音样本' },
        chapters: entries,
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Generated', b.id);
}
