-- Initial schema, DESIGN.md 7.6 and docs/design/architecture.md 5.2 (Phase 0 subset).

CREATE TABLE documents (
  id               TEXT PRIMARY KEY,          -- SHA-256 hex of the bytes
  title            TEXT NOT NULL,
  author           TEXT,
  page_count       INTEGER NOT NULL,
  byte_size        INTEGER NOT NULL,
  source_path      TEXT,                      -- last local file it was opened from
  file_name        TEXT,                      -- original file name (uploads have no source_path)
  page_labels_json TEXT,
  outline_json     TEXT,
  derived_from     TEXT REFERENCES documents(id),
  added_at         TEXT NOT NULL,
  last_opened_at   TEXT
);
CREATE INDEX documents_source_path ON documents(source_path);

CREATE TABLE sources (
  url_norm      TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  doc_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  etag          TEXT,
  last_modified TEXT,
  fetched_at    TEXT NOT NULL
);

CREATE TABLE passages (
  id                TEXT PRIMARY KEY,
  doc_id            TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  start_page        INTEGER NOT NULL,
  start_offset      INTEGER NOT NULL,
  end_page          INTEGER NOT NULL,
  end_offset        INTEGER NOT NULL,
  kind              TEXT NOT NULL,
  text              TEXT NOT NULL,
  quote_json        TEXT NOT NULL,
  rects_json        TEXT NOT NULL,
  segmenter_version INTEGER NOT NULL,
  quality           TEXT
);
CREATE INDEX passages_doc_page ON passages(doc_id, start_page);

CREATE TABLE threads (
  id            TEXT PRIMARY KEY,
  doc_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  passage_id    TEXT REFERENCES passages(id) ON DELETE SET NULL,
  location_json TEXT NOT NULL,
  title         TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX threads_doc ON threads(doc_id, created_at);

CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,             -- order inside the thread
  role          TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content       TEXT NOT NULL,                -- what the UI shows
  prompt        TEXT,                         -- user turns: the exact text sent to the model
  preset        TEXT,
  status        TEXT NOT NULL CHECK (status IN ('complete', 'streaming', 'cancelled', 'error', 'interrupted')),
  profile       TEXT,
  model         TEXT,
  finish_reason TEXT,
  usage_json    TEXT,
  context_used  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX messages_thread ON messages(thread_id, seq);
CREATE INDEX messages_status ON messages(status);

CREATE TABLE usage (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id              TEXT NOT NULL,
  message_id          TEXT REFERENCES messages(id) ON DELETE SET NULL,
  doc_id              TEXT,
  profile             TEXT NOT NULL,
  model               TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL,
  at                  TEXT NOT NULL
);
CREATE INDEX usage_at ON usage(at);
CREATE INDEX usage_doc ON usage(doc_id);

CREATE TABLE reading_state (
  doc_id              TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  page                INTEGER NOT NULL,
  scroll_frac         REAL NOT NULL,
  zoom_json           TEXT NOT NULL,
  cursor_passage_json TEXT,
  updated_at          TEXT NOT NULL
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
