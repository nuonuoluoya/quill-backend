import type { Book, ContentType, Season } from '../contracts/src/index.js';

const assert = (ok: unknown, message: string) => { if (!ok) throw Error(message); };

/** Called only after the extension JSON Schema has validated field types. */
export function validateContentMetadata(book: any) {
  const type: ContentType = book.contentType ?? 'book';
  const seasons: Season[] = book.seasons ?? [];
  if ('previewOfBookId' in book || 'lockedChapters' in book) {
    assert(type === 'book' && book.contentScope === 'sample' && book.chapters.length === 1 &&
      typeof book.previewOfBookId === 'string' && book.previewOfBookId !== book.book.id &&
      Array.isArray(book.lockedChapters), '预览必须为独立单章书籍样本并成对提供来源和锁章目录');
    const ids = new Set(book.chapters.map((c: any) => c.id));
    for (const [i, chapter] of book.lockedChapters.entries()) {
      assert(!ids.has(chapter.id) && chapter.number === i + 2, '锁章 ID 重复或章序号不连续');
      ids.add(chapter.id);
    }
  }
  if (book.coverUrl !== undefined) {
    const url = new URL(book.coverUrl);
    assert(url.protocol === 'https:' && !!url.hostname && !url.username && !url.password,
      '封面必须为不含账号密码的 HTTPS 地址');
  }
  assert(type === 'podcast' || !('podcastParts' in book), '仅播客允许声明节目部分');
  if (type === 'podcast') {
    const parts: string[] = book.podcastParts ?? ['dialogue', 'lesson'];
    assert(parts.length < 2 || parts[0] === 'dialogue', '播客部分声明须按对话、教学排列');
    assert(!('seasons' in book) && book.chapters.every((c: any) =>
      !('seasonId' in c) && !('episodeNumber' in c)), '播客不能混用电视剧季集字段');
    const episodes = book.episodes ?? [];
    assert(episodes.length > 0, '播客必须提供期目录');
    const byId = new Map<string, number>();
    let previousNumber = 0;
    for (const episode of episodes) {
      assert(!byId.has(episode.id) && episode.number > previousNumber, '播客期 ID 重复或期号未递增');
      byId.set(episode.id, episode.number);
      previousNumber = episode.number;
    }
    const used = new Set<string>();
    let lastNumber = 0, lastPart = -1;
    for (const chapter of book.chapters) {
      const number = byId.get(chapter.episodeId);
      const part = ['dialogue', 'lesson'].indexOf(chapter.part);
      assert(number !== undefined && part >= 0 && parts.includes(chapter.part), '播客部分必须指定有效期 ID 与节目声明的对话/教学类型');
      assert(number! > lastNumber || (number === lastNumber && part > lastPart),
        '播客部分须按期号、对话和教学排列，不能重复');
      used.add(chapter.episodeId);
      lastNumber = number!;
      lastPart = part;
    }
    assert(used.size === episodes.length, '播客每期至少需要一个实际部分');
    return;
  }
  assert(!('episodes' in book) && book.chapters.every((c: any) =>
    !('episodeId' in c) && !('part' in c)), '仅播客允许期目录和部分字段');
  if (type !== 'tv') {
    assert(!('seasons' in book) && book.chapters.every((c: any) =>
      !('seasonId' in c) && !('episodeNumber' in c)), '仅电视剧允许季和集号字段');
    return;
  }
  const byId = new Map<string, Season>();
  let previousOrder = 0;
  for (const season of seasons) {
    assert(!byId.has(season.id) && season.order > previousOrder, '季 ID 重复或季顺序无效');
    byId.set(season.id, season);
    previousOrder = season.order;
  }
  const used = new Set<string>();
  let lastOrder = 0, lastEpisode = 0;
  for (const [index, chapter] of book.chapters.entries()) {
    let order = 0;
    if (seasons.length) {
      const season = byId.get(chapter.seasonId);
      assert(season && chapter.episodeNumber !== undefined, '分季电视剧必须指定有效季与集号');
      order = season!.order;
      used.add(season!.id);
    } else assert(!('seasonId' in chapter), '平铺电视剧不能指定季');
    const episode = chapter.episodeNumber ?? index + 1;
    assert(order >= lastOrder && (order > lastOrder || episode > lastEpisode),
      '剧集须按季与集号递增排列，集号不能重复');
    lastOrder = order;
    lastEpisode = episode;
  }
  assert(used.size === seasons.length, '每季至少需要一集');
}

export function episodeFields(book: any, entry: any, index: number) {
  if (book.contentType === 'podcast') return { episodeId: entry.episodeId as string, part: entry.part as 'dialogue' | 'lesson' };
  return book.contentType === 'tv' ? {
    ...(entry.seasonId !== undefined ? { seasonId: entry.seasonId as string } : {}),
    episodeNumber: (entry.episodeNumber ?? index + 1) as number,
  } : {};
}

/** Read old immutable snapshots without modifying persisted JSON or digests. */
export function normalizeBook(value: Book): Book {
  return {
    ...value,
    contentType: value.contentType ?? 'book',
    unitCount: value.chapters.length,
    seasons: value.seasons ?? [],
    episodes: value.episodes ?? [],
  };
}
