import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packProtea, unpackProtea } from '../src/model/proteaPack';

const EXPECTED_SHA256 = 'd389a3b90bd02a3b70c909e7df945074bf600e322719c21c9688b692eeb09bf5';
const sourceUrl = process.argv[2]
  ? process.argv[2]
  : new URL('../.private-assets/king-protea.glb', import.meta.url);
const outputUrl = new URL('../src/assets/king-protea.protea', import.meta.url);
const source = await readFile(sourceUrl);
const checksum = createHash('sha256').update(source).digest('hex');

if (checksum !== EXPECTED_SHA256) {
  throw new Error(`Refusing to pack unexpected Protea source (sha256 ${checksum}).`);
}

const packed = packProtea(source);
const decoded = unpackProtea(packed);
if (!Buffer.from(decoded).equals(source)) {
  throw new Error('Protea package did not round-trip to the source bytes.');
}
await mkdir(dirname(fileURLToPath(outputUrl)), { recursive: true });
await writeFile(outputUrl, packed);
console.log(`Packed ${source.byteLength.toLocaleString()} bytes into ${packed.byteLength.toLocaleString()} bytes (MPRT v1).`);
