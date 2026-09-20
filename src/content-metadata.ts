import type { Book, ContentType, Season } from '../contracts/src/index.js';

const assert = (ok: unknown, message: string) => { if (!ok) throw Error(message); };

/** Called only after the extension JSON Schema has validated field types. */
export function validateContentMetadata(book: any) {
  const type: ContentType = book.contentType ?? 'book';
  const seasons: Season[] = book.seasons ?? [];
  if (book.coverUrl !== undefined) {
    const url = new URL(book.coverUrl);
    assert(url.protocol === 'https:' && !!url.hostname && !url.username && !url.password,
      '封面必须为不含账号密码的 HTTPS 地址');
  }
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
  };
}
