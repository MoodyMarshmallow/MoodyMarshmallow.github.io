import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { unpackProtea } from './proteaPack';

const proteaUrl = new URL('../assets/king-protea.protea', import.meta.url);

/** Load the compiled Protea asset while retaining GLTFLoader's callback contract. */
export function loadProtea(
  onLoad: (gltf: GLTF) => void,
  onError?: (error: unknown) => void,
): void {
  fetch(proteaUrl)
    .then(async (response) => {
      if (!response.ok) throw new Error(`Protea asset request failed with status ${response.status}.`);
      const packed = await response.arrayBuffer();
      const glb = unpackProtea(packed);
      const glbBuffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
      new GLTFLoader().parse(glbBuffer, new URL('.', proteaUrl).href, onLoad, onError);
    })
    .catch((error: unknown) => onError?.(error));
}
