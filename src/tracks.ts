const AUDIO_EXT = new Set([
  "flac",
  "mp3",
  "m4a",
  "aac",
  "opus",
  "ogg",
  "wav",
  "dsf",
  "dff",
  "alac",
]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** `"1-02 Song_Name.m4a"` → `"Song Name"`. */
export function parseTitle(shortName: string): string {
  const dot = shortName.lastIndexOf(".");
  let base = dot > 0 ? shortName.slice(0, dot) : shortName;
  base = base.replace(/_/g, " ");
  // Two passes: "1-02" needs a disc prefix and a track number stripped.
  for (let i = 0; i < 2; i++) {
    base = base
      .replace(/^\s*\d{1,3}\s*[-.]\s*/, "")
      .replace(/^\s*\d{1,3}\s+/, "");
  }
  return base.trim();
}

/** TorBox has no artist field; the album name is `"Artist - Album (year) [...]"`. */
export function parseArtist(torrentName: string): string {
  const sep = torrentName.indexOf(" - ");
  if (sep > 0) return torrentName.slice(0, sep).trim();
  return torrentName.replace(/\s*[\[(].*$/, "").trim();
}

export function isAudio(shortName: string, mimetype?: string): boolean {
  if (mimetype?.startsWith("audio/")) return true;
  return AUDIO_EXT.has(extensionOf(shortName));
}

/**
 * An FTS5 MATCH expression, or null when the query has nothing to look for.
 *
 * Split on anything that is not a letter or digit, because that is exactly what
 * `unicode61` does to the indexed text: `"Re-Up"` is indexed as `re`, `up`. A
 * query that kept the hyphen (`reup`) would match nothing.
 */
export function buildMatchQuery(q: string): string | null {
  const tokens = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}
