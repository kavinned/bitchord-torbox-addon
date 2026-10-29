/**
 * Duration backfill, run from a laptop rather than the Worker.
 *
 * Batches of 100: mint the links, fetch the FLAC headers 8 at a time, write the
 * UPDATEs, apply them, then read the count back before starting the next batch.
 * A bad batch can only be 100 rows.
 *
 * Two hosts, two rules. TorBox's API allows 300/min per key (only ~240 is safe
 * in practice), so mints are serialised at 250 ms. The CDN has no such cap, so
 * header fetches run 8 at a time. Both carry timeouts: 8-wide `Promise.all`
 * means one dead socket otherwise blocks the whole batch forever.
 *
 * Usage: bun scripts/backfill.ts <rows.json>
 */
import { flacSeconds } from "../src/tracks";

const KEY = process.env.TORBOX_KEY;
if (!KEY) throw new Error("TORBOX_KEY is not set");

const BATCH = 100;
const MINT_GAP_MS = 250;
const FETCH_WIDTH = 8;

type Row = { torrent_id: number; file_id: number };
type Result = { row: Row; seconds: number | null; why: string };

const all = (await Bun.file(process.argv[2]).json()) as Row[];
const from = Number(process.argv[3] ?? 0);
const take = Number(process.argv[4] ?? all.length - from);
const rows = all.slice(from, from + take);
console.log(`${rows.length} rows to fill, ${Math.ceil(rows.length / BATCH)} batches`);

async function mint(row: Row): Promise<{ row: Row; link: string | null; why: string }> {
  const url = new URL("https://api.torbox.app/v1/api/torrents/requestdl");
  url.searchParams.set("token", KEY!);
  url.searchParams.set("torrent_id", String(row.torrent_id));
  url.searchParams.set("file_id", String(row.file_id));
  url.searchParams.set("redirect", "false");

  for (let attempt = 0; attempt < 6; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${KEY}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      return { row, link: null, why: `mint threw: ${(e as Error).message}` };
    }
    if (res.status === 429) {
      await Bun.sleep((Number(res.headers.get("retry-after") ?? 60) + 2) * 1000);
      continue;
    }
    if (!res.ok) return { row, link: null, why: `mint ${res.status}` };
    const body = (await res.json()) as { success?: boolean; data?: string };
    if (body.success !== true || typeof body.data !== "string") {
      return { row, link: null, why: "mint no-data" };
    }
    return { row, link: body.data, why: "" };
  }
  return { row, link: null, why: "mint 429-exhausted" };
}

async function secondsOf(m: { row: Row; link: string | null; why: string }): Promise<Result> {
  if (!m.link) return { row: m.row, seconds: null, why: m.why };
  try {
    const res = await fetch(m.link, {
      headers: { Authorization: `Bearer ${KEY}`, Range: "bytes=0-8191" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { row: m.row, seconds: null, why: `range ${res.status}` };
    const seconds = flacSeconds(new Uint8Array(await res.arrayBuffer()));
    return { row: m.row, seconds, why: seconds === null ? "not-flac" : "" };
  } catch (e) {
    return { row: m.row, seconds: null, why: `fetch threw: ${(e as Error).message}` };
  }
}

/** Runs one wrangler call and returns its parsed payload (`meta` carries the counts). */
async function d1(args: string[]): Promise<any> {
  const proc = Bun.spawn(["cmd", "/c", "bunx", "wrangler", "d1", "execute", "bitchord-addon", "--remote", "--json", ...args], {
    stdout: "pipe",
    stderr: "ignore",
    cwd: import.meta.dir + "/..",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const start = text.indexOf("[");
  if (start < 0) throw new Error(`unparseable: ${text.slice(0, 160)}`);
  return JSON.parse(text.slice(start))[0];
}

const reasons = new Map<string, number>();

for (let start = 0; start < rows.length; start += BATCH) {
  const slice = rows.slice(start, start + BATCH);
  const batch = start / BATCH;

  const minted = [];
  for (const row of slice) {
    minted.push(await mint(row));
    await Bun.sleep(MINT_GAP_MS);
  }

  const results: Result[] = [];
  for (let i = 0; i < minted.length; i += FETCH_WIDTH) {
    results.push(...(await Promise.all(minted.slice(i, i + FETCH_WIDTH).map(secondsOf))));
  }

  for (const r of results) {
    const key = r.why || "ok";
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }

  const updates = results
    .filter((r) => r.seconds !== null)
    .map(
      (r) => `UPDATE tracks SET duration = ${r.seconds} WHERE torrent_id = ${r.row.torrent_id} AND file_id = ${r.row.file_id};`,
    );

  let applied = 0;
  if (updates.length > 0) {
    const path = `/tmp/backfill/${String(batch).padStart(3, "0")}.sql`;
    await Bun.write(path, updates.join("\n") + "\n");
    applied = (await d1(["--file", path]))?.meta?.rows_written ?? 0;
  }

  const check = (
    await d1(["--command", "SELECT SUM(duration IS NOT NULL) AS filled, SUM(duration > 7200) AS bogus FROM tracks"])
  ).results[0];
  console.log(
    `batch ${batch}: ${results.length} probed, ${updates.length} found, ${applied} applied, ` +
      `filled=${check.filled}, bogus=${check.bogus}`,
  );
}

console.log("reasons:", [...reasons.entries()].map(([k, v]) => `${k}=${v}`).join(" "));
