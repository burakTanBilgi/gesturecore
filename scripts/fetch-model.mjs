// Downloads the MediaPipe hand landmarker model used by the bench, and refuses any file
// that is not byte-for-byte the one the bench was built and tested against.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A versioned address, not "latest": the file behind it should never change.
const URL_ =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const SHA256 = 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1';

const dir = fileURLToPath(new URL('../bench/models/', import.meta.url));
const out = `${dir}hand_landmarker.task`;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

if (existsSync(out) && !process.argv.includes('--force')) {
  const have = sha256(readFileSync(out));
  if (have !== SHA256) {
    console.error(`${out} does not match the expected model (sha256 ${have}); run with --force to replace it`);
    process.exit(1);
  }
  console.log(`already present and verified (${(statSync(out).size / 1e6).toFixed(1)} MB): ${out}`);
  process.exit(0);
}

mkdirSync(dir, { recursive: true });
const res = await fetch(URL_);
if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
const buf = Buffer.from(await res.arrayBuffer());
const got = sha256(buf);
if (got !== SHA256) throw new Error(`downloaded model has sha256 ${got}, expected ${SHA256}; refusing to use it`);
writeFileSync(out, buf);
console.log(`saved and verified ${(buf.length / 1e6).toFixed(1)} MB to ${out}`);
