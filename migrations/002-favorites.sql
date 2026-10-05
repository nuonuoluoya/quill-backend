BEGIN;
CREATE TABLE IF NOT EXISTS favorite_accounts (
  user_id text PRIMARY KEY REFERENCES users(id),
  version bigint NOT NULL DEFAULT 0 CHECK(version>=0 AND version<=9007199254740991)
);
CREATE TABLE IF NOT EXISTS sentence_favorites (
  user_id text NOT NULL REFERENCES users(id),
  favorite_id text NOT NULL CHECK(favorite_id ~ '^[a-f0-9]{64}$'),
  book_id text NOT NULL, text_revision text NOT NULL, chapter_id text NOT NULL, sentence_id text NOT NULL,
  source_build_id text NOT NULL, favorited_at timestamptz NOT NULL,
  added_version bigint NOT NULL CHECK(added_version>0 AND added_version<=9007199254740991),
  PRIMARY KEY(user_id,favorite_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS favorites_recent ON sentence_favorites(user_id,added_version DESC);
CREATE INDEX IF NOT EXISTS favorites_chapter ON sentence_favorites(user_id,book_id,text_revision,chapter_id);
CREATE TABLE IF NOT EXISTS favorite_mutations (
  user_id text NOT NULL REFERENCES users(id), client_mutation_id text NOT NULL,
  digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,client_mutation_id)
);
CREATE INDEX IF NOT EXISTS favorite_mutation_expiry ON favorite_mutations(created_at);
COMMIT;