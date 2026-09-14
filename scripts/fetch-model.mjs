// Downloads the MediaPipe hand landmarker model used by the bench.
import { mkdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const URL_ =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';
const dir = fileURLToPath(new URL('../bench/models/', import.meta.url));
const out = `${dir}hand_landmarker.task`;

if (existsSync(out) && !process.argv.includes('--force')) {
  console.log(`already present (${(statSync(out).size / 1e6).toFixed(1)} MB): ${out}`);
  process.exit(0);
}

mkdirSync(dir, { recursive: true });
const res = await fetch(URL_);
if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
const buf = Buffer.from(await res.arrayBuffer());
writeFileSync(out, buf);
console.log(`saved ${(buf.length / 1e6).toFixed(1)} MB to ${out}`);
