// Downloads the MediaPipe models used by the bench, and refuses any file that is not
// byte-for-byte the one the bench was built and tested against.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Versioned addresses, not "latest": the files behind them should never change.
const MODELS = [
  {
    // hands, for the core
    file: 'hand_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    sha256: 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1',
  },
  {
    // the face, for the head reader brick
    file: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
  },
];

const dir = fileURLToPath(new URL('../bench/models/', import.meta.url));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const force = process.argv.includes('--force');
mkdirSync(dir, { recursive: true });

for (const m of MODELS) {
  const out = `${dir}${m.file}`;
  if (existsSync(out) && !force) {
    const have = sha256(readFileSync(out));
    if (have !== m.sha256) {
      console.error(`${out} does not match the expected model (sha256 ${have}); run with --force to replace it`);
      process.exit(1);
    }
    console.log(`already present and verified (${(statSync(out).size / 1e6).toFixed(1)} MB): ${out}`);
    continue;
  }
  const res = await fetch(m.url);
  if (!res.ok) throw new Error(`download of ${m.file} failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== m.sha256) throw new Error(`downloaded ${m.file} has sha256 ${got}, expected ${m.sha256}; refusing to use it`);
  writeFileSync(out, buf);
  console.log(`saved and verified ${(buf.length / 1e6).toFixed(1)} MB to ${out}`);
}
