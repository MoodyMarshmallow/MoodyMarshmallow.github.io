import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { unpackProtea } from '../src/model/proteaPack';

interface GltfPrimitive {
  attributes: Record<string, number>;
  indices: number;
}

interface GltfMesh {
  primitives: GltfPrimitive[];
}

interface GltfAccessor {
  count: number;
}

interface GltfDocument {
  meshes: GltfMesh[];
  accessors: GltfAccessor[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePrimitive(value: unknown): GltfPrimitive {
  if (!isRecord(value) || !isRecord(value.attributes)) {
    throw new Error('GLB mesh primitive is malformed');
  }

  const attributes: Record<string, number> = {};
  for (const [name, accessor] of Object.entries(value.attributes)) {
    if (!Number.isInteger(accessor) || (accessor as number) < 0) {
      throw new Error(`GLB attribute ${name} has an invalid accessor index`);
    }
    attributes[name] = accessor as number;
  }

  if (!Number.isInteger(value.indices) || (value.indices as number) < 0) {
    throw new Error('GLB mesh primitive has an invalid index accessor');
  }

  return { attributes, indices: value.indices as number };
}

function parseGltf(value: unknown): GltfDocument {
  if (!isRecord(value) || !Array.isArray(value.meshes) || !Array.isArray(value.accessors)) {
    throw new Error('GLB JSON does not contain mesh and accessor arrays');
  }

  const meshes = value.meshes.map((mesh): GltfMesh => {
    if (!isRecord(mesh) || !Array.isArray(mesh.primitives)) {
      throw new Error('GLB mesh is malformed');
    }
    return { primitives: mesh.primitives.map(parsePrimitive) };
  });

  const accessors = value.accessors.map((accessor): GltfAccessor => {
    if (!isRecord(accessor) || !Number.isInteger(accessor.count) || (accessor.count as number) < 0) {
      throw new Error('GLB accessor has an invalid count');
    }
    return { count: accessor.count as number };
  });

  return { meshes, accessors };
}

const modelUrl = new URL('../src/assets/king-protea.protea', import.meta.url);
const packedBytes = await readFile(modelUrl);
const bytes = Buffer.from(unpackProtea(packedBytes));
const checksum = createHash('sha256').update(bytes).digest('hex');
const repairedChecksum = 'd389a3b90bd02a3b70c909e7df945074bf600e322719c21c9688b692eeb09bf5';

if (checksum !== repairedChecksum) {
  throw new Error('Protea geometry differs from the overlap-repaired asset');
}

if (bytes.toString('ascii', 0, 4) !== 'glTF') throw new Error('Compiled protea payload is not binary glTF');

if (bytes.length < 20) throw new Error('Compiled protea payload has a truncated header');
const jsonLength = bytes.readUInt32LE(12);
const jsonType = bytes.toString('ascii', 16, 20);
if (jsonType !== 'JSON') throw new Error('GLB JSON chunk is missing');
if (20 + jsonLength > bytes.length) throw new Error('GLB JSON chunk is truncated');

const parsed: unknown = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
const gltf = parseGltf(parsed);
const primitives = gltf.meshes.flatMap((mesh) => mesh.primitives);

if (primitives.length !== 1) {
  throw new Error(`Expected one protea primitive, found ${primitives.length}`);
}

const primitive = primitives[0];
if (!primitive) throw new Error('Protea primitive is missing');
if (primitive.attributes.NORMAL === undefined) {
  throw new Error('Protea primitive is missing authored vertex normals');
}

const indexAccessor = gltf.accessors[primitive.indices];
if (!indexAccessor) throw new Error('Protea index accessor is missing');
const triangleCount = indexAccessor.count / 3;
if (triangleCount !== 21027) {
  throw new Error(`Expected 21,027 source triangles, found ${triangleCount.toLocaleString()}`);
}

console.log('Model check passed: authored normals present; 21,027 source triangles.');
