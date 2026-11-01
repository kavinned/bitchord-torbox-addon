CREATE TABLE IF NOT EXISTS tracks (
  id         INTEGER PRIMARY KEY,
  torrent_id INTEGER NOT NULL,
  file_id    INTEGER NOT NULL,
  title      TEXT    NOT NULL,
  artist     TEXT    NOT NULL,
  album      TEXT,
  size       INTEGER NOT NULL,
  format     TEXT    NOT NULL,
  -- Seconds, read from the FLAC STREAMINFO header. Null until the cron has
  -- seen the file; -1 once it tried and could not reach it, so the same
  -- unreachable files are not re-probed on every tick. The app refuses a
  -- mid-track swap without a duration: a candidate whose runtime differs by
  -- more than 2 s is not the same recording.
  duration   INTEGER,
  UNIQUE (torrent_id, file_id)
);

-- The cron asks "any durations left?" every 2 minutes. Without this, that is a
-- full table scan returning nothing, which was ~83% of the daily D1 row-read
-- budget. Partial, so it stays empty once the backfill is done.
CREATE INDEX IF NOT EXISTS tracks_need_duration ON tracks(id) WHERE duration IS NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
  title,
  artist,
  content = 'tracks',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- D1's SQLite rejects `new.id` here ("no such column"); the rowid alias is the
-- form it accepts, and it is the same value.
CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN
  INSERT INTO tracks_fts (rowid, title, artist) VALUES (new.rowid, new.title, new.artist);
END;

-- The FTS table is external-content, so a delete is never automatic: without
-- this the row leaves `tracks` and its terms stay in the index forever.
CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN
  INSERT INTO tracks_fts (tracks_fts, rowid, title, artist)
  VALUES ('delete', old.rowid, old.title, old.artist);
END;

CREATE TABLE IF NOT EXISTS sync_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  cursor       INTEGER NOT NULL DEFAULT 0,
  next_walk_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO sync_state (id, cursor, next_walk_at) VALUES (1, 0, 0);
