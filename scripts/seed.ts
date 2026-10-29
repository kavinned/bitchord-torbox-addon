import { writeFile } from "node:fs/promises";
import { extensionOf, isAudio, parseArtist, parseTitle } from "../src/tracks";

const KEY = process.env.TORBOX_KEY;
if (!KEY) {
  console.error("TORBOX_KEY is not set");
  process.exit(1);
}

const PAGE = 100;
const stmts: string[] = [];
let torrents = 0;
let files = 0;
let offset = 0;

const num = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.trunc(n)) : "0";
};
const str = (v: string): string => `'${v.replace(/'/g, "''")}'`;

while (true) {
  const res = await fetch(
    `https://api.torbox.app/v1/api/torrents/mylist?limit=${PAGE}&offset=${offset}`,
    { headers: { Authorization: `Bearer ${KEY}` } },
  );
  if (!res.ok) {
    console.error(`mylist failed: HTTP ${res.status}`);
    process.exit(1);
  }
  const page = ((await res.json()) as { data?: any[] }).data ?? [];
  if (page.length === 0) break;

  for (const t of page) {
    torrents++;
    const artist = parseArtist(String(t.name ?? ""));
    for (const f of t.files ?? []) {
      const shortName = String(f.short_name ?? "");
      if (!isAudio(shortName, f.mimetype)) continue;
      files++;
      stmts.push(
        "INSERT INTO tracks(torrent_id,file_id,title,artist,album,size,format) " +
          `SELECT ${num(t.id)},${num(f.id)},${str(parseTitle(shortName))},${str(artist)},` +
          `${str(String(t.name ?? ""))},${num(f.size)},${str(extensionOf(shortName))} ` +
          "WHERE NOT EXISTS (SELECT 1 FROM tracks " +
          `WHERE torrent_id=${num(t.id)} AND file_id=${num(f.id)});`,
      );
    }
  }

  if (page.length < PAGE) break;
  offset += page.length;
}

await writeFile("seed.sql", stmts.join("\n") + "\n");
console.log(`torrents=${torrents} audio_files=${files} statements=${stmts.length}`);
