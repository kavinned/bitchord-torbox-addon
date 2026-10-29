import { expect, test } from "bun:test";
import { buildMatchQuery, extensionOf, flacSeconds, isFlac, parseArtist, parseTitle, publicDuration } from "../src/tracks";

/** Real bytes, captured from a file in the library. */
const REAL_HEAD = new Uint8Array([
  0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x22, 0x10, 0x00, 0x10, 0x00, 0x00, 0x01, 0xe3, 0x00,
  0x39, 0x1e, 0x0a, 0xc4, 0x42, 0xf0, 0x00, 0x8e, 0x45, 0x8c, 0xa5, 0x36, 0x7d, 0x84, 0x43, 0x4d,
  0x28, 0x48, 0x9b, 0xc0, 0xcb, 0x16, 0xe7, 0x04, 0x30, 0xd2,
]);

/** A FLAC header as far as the duration goes: magic, STREAMINFO, two fields. */
function flacHead(sampleRate: number, totalSamples: number): Uint8Array {
  const b = new Uint8Array(42);
  b.set([0x66, 0x4c, 0x61, 0x43], 0); // "fLaC"
  b.set([0x80, 0x00, 0x00, 0x22], 4); // STREAMINFO, 34 bytes, last block
  b[18] = (sampleRate >> 12) & 0xff;
  b[19] = (sampleRate >> 4) & 0xff;
  // Low nibble of the rate, then channels-1 and bps-1 occupy what is left of
  // byte 20; the 36-bit sample count starts in byte 21's low nibble.
  b[20] = ((sampleRate & 0x0f) << 4) | 0x02;
  b[21] = ((totalSamples / 2 ** 32) | 0) & 0x0f;
  b[22] = (totalSamples >> 24) & 0xff;
  b[23] = (totalSamples >> 16) & 0xff;
  b[24] = (totalSamples >> 8) & 0xff;
  b[25] = totalSamples & 0xff;
  return b;
}

test("duration comes from the STREAMINFO header", () => {
  // 9,323,916 samples at 44.1kHz.
  expect(flacSeconds(REAL_HEAD)).toBe(211);
  expect(flacSeconds(flacHead(44100, 7869792))).toBe(178);
  expect(flacSeconds(flacHead(48000, 14400000))).toBe(300);
});

test("anything that is not a FLAC stream has no duration", () => {
  expect(flacSeconds(new Uint8Array(42))).toBeNull();
  expect(flacSeconds(new Uint8Array(10))).toBeNull();
  const notStreaminfo = flacHead(44100, 7869792);
  notStreaminfo[4] = 0x04; // a VORBIS_COMMENT first: no STREAMINFO to read
  expect(flacSeconds(notStreaminfo)).toBeNull();
});

test("strips track number and extension", () => {
  expect(parseTitle("01 - ELEVEN.flac")).toBe("ELEVEN");
  expect(parseTitle("07. Take It.mp3")).toBe("Take It");
  expect(parseTitle("1-02 Song_Name.m4a")).toBe("Song Name");
});

test("artist is the torrent name before the first dash", () => {
  expect(parseArtist("IVE - ELEVEN (2021) [FLAC 16bit-44.1kHz]")).toBe("IVE");
  expect(parseArtist("No Dash Album")).toBe("No Dash Album");
});

test("extension is lowercased", () => {
  expect(extensionOf("a.FLAC")).toBe("flac");
});

test("only flac is indexed, whatever the mimetype says", () => {
  expect(isFlac("01 - ELEVEN.flac")).toBe(true);
  expect(isFlac("01 - ELEVEN.FLAC")).toBe(true);
  expect(isFlac("01 - ELEVEN.mp3")).toBe(false);
  expect(isFlac("cover.jpg")).toBe(false);
});

test("a probed-and-failed row reports no duration, not a negative one", () => {
  // -1 marks a file the prober could not reach, so the cron stops asking. It
  // must never reach the client: the app would compare it against a playing
  // track's length like any other number.
  expect(publicDuration(178)).toBe(178);
  expect(publicDuration(-1)).toBeUndefined();
  expect(publicDuration(null)).toBeUndefined();
  expect(publicDuration(0)).toBeUndefined();
});

test("query is quoted and prefix-matched per token", () => {
  expect(buildMatchQuery("ive eleven")).toBe('"ive"* OR "eleven"*');
  expect(buildMatchQuery("  a  ")).toBeNull();
});

test("punctuation splits tokens the same way the fts index does", () => {
  expect(buildMatchQuery('foo"bar')).toBe('"foo"* OR "bar"*');
  expect(buildMatchQuery("re-up")).toBe('"re"* OR "up"*');
  expect(buildMatchQuery("ac/dc")).toBe('"ac"* OR "dc"*');
});

test("fts operators in input are inert", () => {
  expect(buildMatchQuery("NEAR( a * )")).toBe('"near"*');
});
