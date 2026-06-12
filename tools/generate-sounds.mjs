/**
 * Sons procéduraux (WAV 16 bits mono 44,1 kHz) écrits dans assets/sounds.
 * Les autres sons du jeu sont des CC0 (Kenney) déjà présents — ici on ne
 * génère que ce qui n'existe pas en libre : la boucle de rotor d'hélico.
 *
 * Usage : npm run sounds
 */
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const SR = 44100;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "sounds");

function writeWav(name, samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(join(OUT, name), buf);
  console.log(`✓ ${name} (${(n / SR).toFixed(2)}s)`);
}

/* helico.wav — boucle de rotor : 20 « whumps » exacts sur 1,6 s (12,5 Hz)
 * et 136 cycles pleins de basse 85 Hz, pour un raccord de boucle sans clic. */
{
  const dur = 1.6;
  const n = Math.round(SR * dur);
  const s = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const pulse = Math.exp(-((t * 12.5) % 1) * 6);
    const white = Math.random() * 2 - 1;
    lp += 0.18 * (white - lp); // souffle filtré passe-bas
    const bass = Math.sin(2 * Math.PI * 85 * t);
    s[i] = Math.tanh((bass * 0.55 + lp * 1.1) * pulse * 1.4) * 0.5;
  }
  writeWav("helico.wav", s);
}
