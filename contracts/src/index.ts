/** Platform-neutral HTTP contract. Never import Node/Nest/ORM here. */
export const speeds = [0.75, 1, 1.25, 1.5] as const;
export type Speed = (typeof speeds)[number];
export type AlignmentStatus =
  | 'auto_passed'
  | 'verified'
  | 'needs_review'
  | 'unmatched'
  | 'excluded';
export type Visibility = 'sample-public' | 'private';
export interface AudioInfo {
  status: 'available' | 'unavailable';
  audioId: string | null;
  duration: number | null;
  reasons: string[];
}
export interface Sentence {
  id: string;
  index: number;
  text: string;
  sourceText?: string;
  duration: number | null;
  audioId: string | null;
  alignment: { status: AlignmentStatus; reasons: string[] };
}
export interface ChapterEntry {
  id: string;
  title: string;
  sentenceCount: number;
  playableCount: number;
  duration: number;
  chapterAudioStatus: AudioInfo['status'];
}
export interface Book {
  bookId: string;
  buildId: string;
  textRevision: string;
  title: string;
  language: string;
  edition: string;
  contentScope: 'sample' | 'complete';
  visibility: Visibility;
  chapters: ChapterEntry[];
}
export interface BookSummary extends Omit<Book, 'chapters'> {
  chapterCount: number;
  contentChapterCount: number;
  sentenceCount: number;
  playableCount: number;
  chapterAudioAvailableCount: number;
}
export interface BookPage {
  items: BookSummary[];
  nextCursor: string | null;
}
export interface Chapter {
  bookId: string;
  buildId: string;
  textRevision: string;
  chapterId: string;
  chapterDuration: number;
  chapterAudio: AudioInfo;
  sentences: Sentence[];
}
export interface Playback {
  audioId: string;
  url: string;
  issuedAt: string;
  expiresAt: string;
  duration: number;
}
export interface Progress {
  bookId: string;
  textRevision: string;
  sourceBuildId: string;
  chapterId: string;
  sentenceId: string;
  preferredSpeed: Speed;
  updatedAt: string;
}
export interface ProgressResult {
  version: number;
  progress: Progress | null;
}
export interface ProgressWrite {
  textRevision: string;
  sourceBuildId: string;
  chapterId: string;
  sentenceId: string;
  preferredSpeed: Speed;
  expectedVersion: number;
  clientMutationId: string;
}
export interface ProgressReset {
  textRevision: string;
  expectedVersion: number;
  clientMutationId: string;
}
export interface Session {
  accessToken: string;
  expiresAt: string;
  user: { id: string };
}
export interface ApiErrorBody {
  error: { code: string; message: string; details: Record<string, unknown> };
  requestId: string;
}
export interface Envelope<T> {
  data: T;
  requestId: string;
}
export const playable = (s: Sentence) =>
  (s.alignment.status === 'verified' || s.alignment.status === 'auto_passed') &&
  !!s.audioId &&
  (s.duration ?? 0) > 0;
export function searchSentences(sentences: Sentence[], query: string) {
  const q = query.trim().toLocaleLowerCase();
  return q ? sentences.filter((s) => s.text.toLocaleLowerCase().includes(q)) : sentences;
}
export function isSpeed(value: unknown): value is Speed {
  return speeds.includes(value as Speed);
}
export function fullAudioLabel(b: BookSummary) {
  return b.chapterAudioAvailableCount > 0
    ? b.chapterAudioAvailableCount === b.contentChapterCount
      ? '全部章节可用'
      : '部分章节可用'
    : '暂不可用';
}
export function timeLabel(seconds: number) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)
    .toString()
    .padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}
