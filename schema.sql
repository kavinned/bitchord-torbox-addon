CREATE TABLE IF NOT EXISTS tracks (
  id         INTEGER PRIMARY KEY,
  torrent_id INTEGER NOT NULL,
  file_id    INTEGER NOT NULL,
  title      TEXT    NOT NULL,
  artist     TEXT    NOT NULL,
  album      TEXT,
  size       INTEGER NOT NULL,
  format     TEXT    NOT NULL,
  UNIQUE (torrent_id, file_id)
);

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

CREATE TABLE IF NOT EXISTS sync_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  cursor       INTEGER NOT NULL DEFAULT 0,
  next_walk_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO sync_state (id, cursor, next_walk_at) VALUES (1, 0, 0);
