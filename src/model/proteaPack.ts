const MAGIC = [0x4d, 0x50, 0x52, 0x54] as const; // MPRT
const GLB_MAGIC = [0x67, 0x6c, 0x54, 0x46] as const; // glTF
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;

export const PROTEA_PACK_VERSION = 1;
export const PROTEA_PACK_HEADER_SIZE = 12;

type BinaryInput = ArrayBuffer | Uint8Array;

function asBytes(input: BinaryInput): Uint8Array {
  return input instanceof Uint8Array
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input);
}

function hasMagic(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((value, index) => bytes[index] === value);
}

function transformPayload(source: Uint8Array): Uint8Array {
  const transformed = new Uint8Array(source.byteLength);
  for (let index = 0; index < source.byteLength; index += 1) {
    const mask = (index * 131 + (index >>> 3) * 17 + 0x5d) & 0xff;
    transformed[index] = source[index] ^ mask;
  }
  return transformed;
}

/** Validate the complete GLB 2.0 container before it enters or leaves a pack. */
export function validateGlb(input: BinaryInput): void {
  const bytes = asBytes(input);
  if (bytes.byteLength < 20) throw new Error('Protea GLB has a truncated header.');
  if (!hasMagic(bytes, GLB_MAGIC)) throw new Error('Protea payload is not a binary glTF file.');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== 2) throw new Error('Protea GLB must use glTF binary version 2.');
  if (view.getUint32(8, true) !== bytes.byteLength) {
    throw new Error('Protea GLB declared length does not match its payload.');
  }

  let offset = 12;
  let chunkIndex = 0;
  let jsonDocument: unknown = null;
  let sawBinChunk = false;

  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error('Protea GLB has a truncated chunk header.');
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    offset += 8;
    if (chunkLength % 4 !== 0) throw new Error('Protea GLB chunk length is not 4-byte aligned.');
    if (offset + chunkLength > bytes.byteLength) throw new Error('Protea GLB has a truncated chunk.');

    if (chunkIndex === 0) {
      if (chunkType !== GLB_JSON_CHUNK) throw new Error('Protea GLB must begin with a JSON chunk.');
      try {
        jsonDocument = JSON.parse(new TextDecoder().decode(bytes.subarray(offset, offset + chunkLength)).trim());
      } catch (error) {
        throw new Error('Protea GLB JSON chunk is invalid.', { cause: error });
      }
    } else if (chunkType === GLB_JSON_CHUNK) {
      throw new Error('Protea GLB contains more than one JSON chunk.');
    } else if (chunkType === GLB_BIN_CHUNK) {
      if (sawBinChunk) throw new Error('Protea GLB contains more than one binary chunk.');
      sawBinChunk = true;
    } else {
      throw new Error(`Protea GLB contains unsupported chunk type 0x${chunkType.toString(16)}.`);
    }

    offset += chunkLength;
    chunkIndex += 1;
  }

  if (offset !== bytes.byteLength || chunkIndex === 0) throw new Error('Protea GLB chunk table is invalid.');
  if (typeof jsonDocument !== 'object' || jsonDocument === null) {
    throw new Error('Protea GLB JSON document is missing.');
  }
  const asset = (jsonDocument as { asset?: { version?: unknown } }).asset;
  if (!asset || asset.version !== '2.0') throw new Error('Protea GLB JSON must declare asset version 2.0.');
}

/** Compile a GLB into the application-specific MPRT v1 container. */
export function packProtea(input: BinaryInput): Uint8Array {
  const source = asBytes(input);
  validateGlb(source);
  const packed = new Uint8Array(PROTEA_PACK_HEADER_SIZE + source.byteLength);
  packed.set(MAGIC, 0);
  const view = new DataView(packed.buffer);
  view.setUint32(4, PROTEA_PACK_VERSION, true);
  view.setUint32(8, source.byteLength, true);
  packed.set(transformPayload(source), PROTEA_PACK_HEADER_SIZE);
  return packed;
}

/** Decode and validate an MPRT v1 container, returning an owned GLB buffer. */
export function unpackProtea(input: BinaryInput): Uint8Array {
  const packed = asBytes(input);
  if (packed.byteLength < PROTEA_PACK_HEADER_SIZE) throw new Error('Protea pack has a truncated header.');
  if (!hasMagic(packed, MAGIC)) throw new Error('Protea pack has an invalid MPRT signature.');

  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const version = view.getUint32(4, true);
  if (version !== PROTEA_PACK_VERSION) throw new Error(`Unsupported Protea pack version ${version}.`);
  const payloadLength = view.getUint32(8, true);
  if (payloadLength !== packed.byteLength - PROTEA_PACK_HEADER_SIZE) {
    throw new Error('Protea pack declared length does not match its payload.');
  }

  const decoded = transformPayload(packed.subarray(PROTEA_PACK_HEADER_SIZE));
  validateGlb(decoded);
  return decoded;
}
