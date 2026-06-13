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

/* menu_music.wav — boucle douce et heroique pour le menu.
 * Progression i–VI–III–VII en La mineur : nappe + arpege + percussions
 * legeres. ~19,2 s (32 temps a 100 BPM). Boucle propre via fondu 30 ms. */
{
  const BPM = 100;
  const beat = 60 / BPM;
  const bars = 8;
  const dur = bars * 4 * beat;
  const n = Math.round(SR * dur);
  const s = new Float32Array(n);

  const add = (t0, d, freq, gain, type = "sine", atk = 0.01, rel = 0.12) => {
    const i0 = Math.max(0, Math.floor(t0 * SR));
    const i1 = Math.min(n, Math.floor((t0 + d) * SR));
    for (let i = i0; i < i1; i++) {
      const t = (i - i0) / SR;
      let env;
      if (t < atk) env = t / atk;
      else if (t > d - rel) env = Math.max(0, (d - t) / rel);
      else env = 1;
      const ph = 2 * Math.PI * freq * t;
      let w;
      if (type === "tri") w = Math.asin(Math.sin(ph)) * (2 / Math.PI);
      else w = Math.sin(ph);
      s[i] += w * env * gain;
    }
  };
  const kick = (t0) => {
    const i0 = Math.floor(t0 * SR);
    const i1 = Math.min(n, i0 + Math.floor(SR * 0.16));
    for (let i = i0; i < i1; i++) {
      const t = (i - i0) / SR;
      const f = 120 * Math.exp(-t * 24) + 45;
      s[i] += Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 12) * 0.45;
    }
  };
  const hat = (t0, g = 0.05) => {
    const i0 = Math.floor(t0 * SR);
    const i1 = Math.min(n, i0 + Math.floor(SR * 0.05));
    for (let i = i0; i < i1; i++) {
      const t = (i - i0) / SR;
      s[i] += (Math.random() * 2 - 1) * Math.exp(-t * 90) * g;
    }
  };

  const N = {
    A2: 110.0, F2: 87.31, C3: 130.81, G2: 98.0,
    A3: 220.0, C4: 261.63, E4: 329.63, F3: 174.61, G3: 196.0, B3: 246.94, D4: 293.66,
    A4: 440.0, C5: 523.25, E5: 659.25, G4: 392.0, D5: 587.33, F4: 349.23, B4: 493.88,
  };
  const prog = [
    { bass: N.A2, pad: [N.A3, N.C4, N.E4], arp: [N.A4, N.C5, N.E5, N.C5] },
    { bass: N.F2, pad: [N.F3, N.A3, N.C4], arp: [N.F4, N.A4, N.C5, N.A4] },
    { bass: N.C3, pad: [N.C4, N.E4, N.G4], arp: [N.C5, N.E5, N.G4, N.E5] },
    { bass: N.G2, pad: [N.G3, N.B3, N.D4], arp: [N.G4, N.B4, N.D5, N.B4] },
  ];

  for (let bar = 0; bar < bars; bar++) {
    const ch = prog[bar % prog.length];
    const t0 = bar * 4 * beat;
    add(t0, 4 * beat, ch.bass, 0.22, "tri", 0.02, 0.3);
    for (const p of ch.pad) add(t0, 4 * beat, p, 0.07, "sine", 0.12, 0.35);
    for (let e = 0; e < 8; e++) {
      add(t0 + e * (beat / 2), (beat / 2) * 0.9, ch.arp[e % ch.arp.length], 0.1, "tri", 0.01, 0.1);
    }
    kick(t0);
    kick(t0 + 2 * beat);
    for (let e = 1; e < 8; e += 2) hat(t0 + e * (beat / 2));
  }

  const fade = Math.floor(SR * 0.03);
  for (let i = 0; i < n; i++) {
    let v = Math.tanh(s[i] * 1.1) * 0.62;
    if (i < fade) v *= i / fade;
    else if (i > n - fade) v *= (n - i) / fade;
    s[i] = v;
  }
  writeWav("menu_music.wav", s);
}
