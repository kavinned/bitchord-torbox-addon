const AUDIO_EXT = new Set([
  "flac",
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

/**
 * Seconds of audio in a FLAC stream, from the first 42 bytes of the file.
 *
 * STREAMINFO is always the first metadata block, and its sample rate (20 bits)
 * and total samples (36 bits) sit packed at byte 18. Returns null rather than
 * throwing: a file that does not open with `fLaC` is not one this index can
 * describe, and the caller's job is to leave it alone.
 */
export function flacSeconds(head: Uint8Array): number | null {
  if (head.length < 26) return null;
  if (head[0] !== 0x66 || head[1] !== 0x4c || head[2] !== 0x61 || head[3] !== 0x43) return null;
  if ((head[4] & 0x7f) !== 0) return null; // first block is not STREAMINFO
  const rate = (head[18] << 12) | (head[19] << 4) | (head[20] >> 4);
  // After the 20-bit rate come channels-1 (3 bits) and bits-per-sample-1
  // (5 bits), so the 36-bit sample count starts at byte 21's low nibble — not
  // at byte 20's. Reading it a nibble early yields ~79 hours for every file.
  const total =
    (head[21] & 0x0f) * 2 ** 32 +
    head[22] * 2 ** 24 +
    head[23] * 2 ** 16 +
    head[24] * 2 ** 8 +
    head[25];
  if (!rate || !total) return null;
  return Math.round(total / rate);
}

/**
 * The duration to hand the client, or nothing.
 *
 * The column holds -1 for a file the prober could not reach, so the cron stops
 * asking for it every tick. That sentinel is internal: the app compares a
 * candidate's length against the playing track's, and -1 would be compared too.
 */
export function publicDuration(seconds: number | null | undefined): number | undefined {
  return seconds !== null && seconds !== undefined && seconds > 0 ? seconds : undefined;
}

/**
 * The index is lossless only: a 320kbps MP3 is what JioSaavn already answers
 * with, so indexing one here buys nothing and costs a round trip. Extension
 * rather than mimetype, because TorBox reports `application/octet-stream` for
 * some of these.
 */
export function isFlac(shortName: string): boolean {
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
