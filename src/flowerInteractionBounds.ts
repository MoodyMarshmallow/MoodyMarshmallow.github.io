import { Box3, Matrix4, Vector3, Vector4 } from 'three';
import type { Object3D, PerspectiveCamera } from 'three';

export type ScreenBounds = { left: number; top: number; right: number; bottom: number };
export type ProjectionViewport = { left: number; top: number; width: number; height: number };

const BOX_EDGES = [
  [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3],
  [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7],
] as const;

/** Cache geometry bounds once, in the rotating flower group's coordinate system. */
export function getLocalFlowerBounds(root: Object3D): Box3 {
  root.updateWorldMatrix(true, true);
  const inverseRoot = root.matrixWorld.clone().invert();
  const relativeMatrix = new Matrix4();
  const bounds = new Box3();
  const corner = new Vector3();
  root.traverse((object) => {
    if (!('geometry' in object)) return;
    const geometry = (object as import('three').Mesh).geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingBox) return;
    relativeMatrix.multiplyMatrices(inverseRoot, object.matrixWorld);
    for (let index = 0; index < 8; index++) {
      corner.set(
        index & 1 ? geometry.boundingBox.max.x : geometry.boundingBox.min.x,
        index & 2 ? geometry.boundingBox.max.y : geometry.boundingBox.min.y,
        index & 4 ? geometry.boundingBox.max.z : geometry.boundingBox.min.z,
      ).applyMatrix4(relativeMatrix);
      bounds.expandByPoint(corner);
    }
  });
  return bounds;
}

export function containsScreenPoint(bounds: ScreenBounds | null, x: number, y: number): boolean {
  return bounds !== null && x >= bounds.left && x <= bounds.right
    && y >= bounds.top && y <= bounds.bottom;
}

/** Projects eight cached corners; clipping near-plane crossings avoids mirrored/infinite bounds. */
export function createFlowerBoundsProjector(localBounds: Box3) {
  const corners = Array.from({ length: 8 }, (_, index) => new Vector4(
    index & 1 ? localBounds.max.x : localBounds.min.x,
    index & 2 ? localBounds.max.y : localBounds.min.y,
    index & 4 ? localBounds.max.z : localBounds.min.z,
    1,
  ));
  const projected = corners.map(() => new Vector4());
  const transform = new Matrix4();
  const crossing = new Vector4();

  return (
    matrixWorld: Matrix4,
    camera: PerspectiveCamera,
    viewport: ProjectionViewport,
    clip: ScreenBounds,
  ): ScreenBounds | null => {
    if (localBounds.isEmpty() || viewport.width <= 0 || viewport.height <= 0) return null;
    transform.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(matrixWorld);
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    const include = (point: Vector4) => {
      if (point.w <= 0) return;
      const x = viewport.left + (point.x / point.w + 1) * viewport.width / 2;
      const y = viewport.top + (1 - point.y / point.w) * viewport.height / 2;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    };
    for (let index = 0; index < 8; index++) {
      const point = projected[index].copy(corners[index]).applyMatrix4(transform);
      if (point.z + point.w >= 0) include(point);
    }
    for (const [start, end] of BOX_EDGES) {
      const a = projected[start];
      const b = projected[end];
      const distanceA = a.z + a.w;
      const distanceB = b.z + b.w;
      if ((distanceA < 0) === (distanceB < 0)) continue;
      include(crossing.copy(a).lerp(b, distanceA / (distanceA - distanceB)));
    }
    left = Math.max(left, clip.left);
    top = Math.max(top, clip.top);
    right = Math.min(right, clip.right);
    bottom = Math.min(bottom, clip.bottom);
    return right > left && bottom > top ? { left, top, right, bottom } : null;
  };
}
