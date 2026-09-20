BEGIN;
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY, appid text NOT NULL, openid text NOT NULL, disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(appid,openid)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS books (
  book_id text PRIMARY KEY, visibility text NOT NULL CHECK(visibility IN ('private','sample-public')), active_build_id text
);
CREATE TABLE IF NOT EXISTS book_builds (
  book_id text NOT NULL REFERENCES books(book_id), build_id text NOT NULL, text_revision text NOT NULL,
  digest text NOT NULL, text_digest text NOT NULL, status text NOT NULL CHECK(status IN ('staged','ready','active','retained','retired','revoked')),
  metadata jsonb NOT NULL, published_at timestamptz, retain_until timestamptz, last_signed_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(book_id,build_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_build ON book_builds(book_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS build_text_revision ON book_builds(book_id,text_revision);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='books_active_build_fk') THEN
  ALTER TABLE books ADD CONSTRAINT books_active_build_fk FOREIGN KEY(book_id,active_build_id) REFERENCES book_builds(book_id,build_id) DEFERRABLE INITIALLY DEFERRED;
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS chapters (
  book_id text NOT NULL, build_id text NOT NULL, chapter_id text NOT NULL, sort_order integer NOT NULL,
  entry jsonb NOT NULL, content jsonb NOT NULL, PRIMARY KEY(book_id,build_id,chapter_id),
  UNIQUE(book_id,build_id,sort_order), FOREIGN KEY(book_id,build_id) REFERENCES book_builds(book_id,build_id)
);
CREATE TABLE IF NOT EXISTS sentences (
  book_id text NOT NULL, build_id text NOT NULL, chapter_id text NOT NULL, sentence_id text NOT NULL,
  sentence_index integer NOT NULL CHECK(sentence_index>0), content jsonb NOT NULL,
  PRIMARY KEY(book_id,build_id,sentence_id), UNIQUE(book_id,build_id,chapter_id,sentence_index),
  FOREIGN KEY(book_id,build_id,chapter_id) REFERENCES chapters(book_id,build_id,chapter_id)
);
CREATE TABLE IF NOT EXISTS audio_assets (
  audio_id text PRIMARY KEY, book_id text NOT NULL, build_id text NOT NULL, chapter_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('sentence','chapter')), sentence_id text,
  object_key text NOT NULL UNIQUE, bytes bigint NOT NULL CHECK(bytes>0), hash text NOT NULL,
  duration double precision NOT NULL CHECK(duration>0 AND duration<'Infinity'),
  FOREIGN KEY(book_id,build_id,chapter_id) REFERENCES chapters(book_id,build_id,chapter_id),
  FOREIGN KEY(book_id,build_id,sentence_id) REFERENCES sentences(book_id,build_id,sentence_id),
  CHECK((kind='chapter' AND sentence_id IS NULL) OR (kind='sentence' AND sentence_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS audio_sentence ON audio_assets(book_id,build_id,sentence_id) WHERE kind='sentence';
CREATE UNIQUE INDEX IF NOT EXISTS audio_chapter ON audio_assets(book_id,build_id,chapter_id) WHERE kind='chapter';
CREATE TABLE IF NOT EXISTS book_access (
  user_id text NOT NULL REFERENCES users(id), book_id text NOT NULL REFERENCES books(book_id),
  starts_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz, revoked_at timestamptz,
  PRIMARY KEY(user_id,book_id)
);
CREATE INDEX IF NOT EXISTS access_book ON book_access(book_id);
CREATE TABLE IF NOT EXISTS reading_progress (
  user_id text NOT NULL REFERENCES users(id), book_id text NOT NULL REFERENCES books(book_id), text_revision text NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK(version>=0 AND version<=9007199254740991), progress jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,book_id,text_revision)
);
CREATE INDEX IF NOT EXISTS progress_book ON reading_progress(book_id,text_revision);
CREATE TABLE IF NOT EXISTS progress_mutations (
  user_id text NOT NULL REFERENCES users(id), client_mutation_id text NOT NULL,
  digest text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,client_mutation_id)
);
CREATE INDEX IF NOT EXISTS mutation_expiry ON progress_mutations(created_at);
CREATE TABLE IF NOT EXISTS content_audits (
  id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, book_id text, build_id text,
  details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
