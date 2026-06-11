/**
 * Convert the downloaded CC0 .ogg sounds to formats iOS Safari can play:
 * .wav for SFX (small files) and .m4a (AAC, via afconvert) for music.
 *
 * Ogg Vorbis is decoded by headless Chromium's WebAudio (no ffmpeg needed).
 *
 * Usage: node tools/convert-sounds.mjs
 */
import { readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";

const SOUNDS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "sounds");
const MUSIC = new Set(["music_battle", "victory", "defeat"]);

const oggs = readdirSync(SOUNDS).filter((f) => f.endsWith(".ogg"));
if (oggs.length === 0) {
  console.log("No .ogg files to convert.");
  process.exit(0);
}

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.goto("about:blank");

for (const f of oggs) {
  const name = f.replace(/\.ogg$/, "");
  const b64 = readFileSync(join(SOUNDS, f)).toString("base64");
  // Decode in Chromium, downmix as-is, re-encode a 16-bit PCM WAV in JS.
  const wavB64 = await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const ctx = new OfflineAudioContext(2, 1, 44100);
    const audio = await ctx.decodeAudioData(bin.buffer);
    const ch = Math.min(2, audio.numberOfChannels);
    const len = audio.length;
    const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
    const w = (off, s) => [...s].forEach((c, i) => data.setUint8(off + i, c.charCodeAt(0)));
    w(0, "RIFF"); data.setUint32(4, 36 + len * ch * 2, true); w(8, "WAVE");
    w(12, "fmt "); data.setUint32(16, 16, true); data.setUint16(20, 1, true);
    data.setUint16(22, ch, true); data.setUint32(24, audio.sampleRate, true);
    data.setUint32(28, audio.sampleRate * ch * 2, true); data.setUint16(32, ch * 2, true);
    data.setUint16(34, 16, true); w(36, "data"); data.setUint32(40, len * ch * 2, true);
    const chans = [];
    for (let c = 0; c < ch; c++) chans.push(audio.getChannelData(c));
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, chans[c][i]));
        data.setInt16(44 + (i * ch + c) * 2, (s * 32767) | 0, true);
      }
    }
    let out = "";
    const bytes = new Uint8Array(data.buffer);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(out);
  }, b64);

  const wavPath = join(SOUNDS, `${name}.wav`);
  writeFileSync(wavPath, Buffer.from(wavB64, "base64"));

  if (MUSIC.has(name)) {
    const m4aPath = join(SOUNDS, `${name}.m4a`);
    execFileSync("afconvert", ["-f", "m4af", "-d", "aac", "-b", "128000", wavPath, m4aPath]);
    unlinkSync(wavPath);
    console.log(`✓ ${name}.m4a (${(statSync(m4aPath).size / 1024).toFixed(0)} KB)`);
  } else {
    console.log(`✓ ${name}.wav (${(statSync(wavPath).size / 1024).toFixed(0)} KB)`);
  }
  unlinkSync(join(SOUNDS, f));
}

await browser.close();
console.log("Done.");
