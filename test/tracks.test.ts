import { expect, test } from "bun:test";
import { buildMatchQuery, extensionOf, isAudio, parseArtist, parseTitle } from "../src/tracks";

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

test("only audio files count, regardless of extension", () => {
  expect(isAudio("album.nfo", undefined)).toBe(false);
  expect(isAudio("cover.jpg", "image/jpeg")).toBe(false);
  expect(isAudio("01 - ELEVEN.flac", "application/octet-stream")).toBe(true);
  expect(isAudio("01 - ELEVEN", "audio/flac")).toBe(true);
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
