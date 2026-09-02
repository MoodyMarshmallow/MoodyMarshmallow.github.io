export const ASCII_PRESET_STORAGE_KEY = 'milo-ascii-home-preset-v1';
export const BASE_ROTATION_RATE = 0.42;

export interface LuminancePoint {
  x: number;
  y: number;
}

export interface Vector3Value {
  x: number;
  y: number;
  z: number;
}

export interface ViewportPreset {
  cameraPosition: Vector3Value;
  spinAngle: number;
  pan: { x: number; y: number };
}

export interface AsciiPreset {
  version: 2;
  color: boolean;
  unicode: boolean;
  glyphSize: number;
  colorBrightness: number;
  colorSaturation: number;
  materialRoughness: number | null;
  rotationSpeed: number;
  defaultTilt: number;
  autoRotate: boolean;
  luminanceCurve: LuminancePoint[];
  viewport: ViewportPreset | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function asNumber(value: unknown): number {
  try {
    return Number(value);
  } catch {
    return Number.NaN;
  }
}

function clamp(value: unknown, min: number, max: number, fallback = min): number {
  const numeric = asNumber(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
}

function normalizeVector(value: unknown): Vector3Value | null {
  const record = asRecord(value);
  const x = asNumber(record?.x);
  const y = asNumber(record?.y);
  const z = asNumber(record?.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

export function normalizeAsciiPreset(value: unknown): AsciiPreset | null {
  const record = asRecord(value);
  if (!record) return null;

  const rawPoints = record.luminanceCurve;
  const points = Array.isArray(rawPoints)
    ? rawPoints
      .map((point: unknown) => {
        const pointRecord = asRecord(point);
        return { x: clamp(pointRecord?.x, 0, 1), y: clamp(pointRecord?.y, 0, 1) };
      })
      .sort((a: LuminancePoint, b: LuminancePoint) => a.x - b.x)
    : [];

  if (points.length < 2) return null;
  points[0] = { x: 0, y: 0 };
  points[points.length - 1] = { x: 1, y: 1 };
  const viewport = asRecord(record.viewport);
  const cameraPosition = normalizeVector(viewport?.cameraPosition);
  const legacyModelRotation = normalizeVector(viewport?.modelRotation);
  const spinAngle = asNumber(viewport?.spinAngle);
  const pan = asRecord(viewport?.pan);
  const panX = clamp(pan?.x, -1, 1, 0);
  const panY = clamp(pan?.y, -1, 1, 0);

  return {
    version: 2,
    color: record.color !== false,
    unicode: Boolean(record.unicode),
    glyphSize: clamp(record.glyphSize, 2, 18, 12),
    colorBrightness: clamp(record.colorBrightness, 0, 100, 50),
    colorSaturation: clamp(record.colorSaturation, -100, 100, 0),
    materialRoughness: record.materialRoughness === null || record.materialRoughness === undefined
      ? null
      : clamp(record.materialRoughness, 0, 1, 0.5),
    rotationSpeed: clamp(record.rotationSpeed, 0, 200, 100),
    defaultTilt: clamp(record.defaultTilt, -45, 45, 0),
    autoRotate: record.autoRotate !== false,
    luminanceCurve: points,
    viewport: cameraPosition
      ? {
        cameraPosition,
        spinAngle: Number.isFinite(spinAngle) ? spinAngle : legacyModelRotation?.y ?? 0,
        pan: { x: panX, y: panY },
      }
      : null,
  };
}

export function loadSavedAsciiPreset(): AsciiPreset | null {
  try {
    const serialized = window.localStorage.getItem(ASCII_PRESET_STORAGE_KEY);
    const parsed: unknown = serialized ? JSON.parse(serialized) : null;
    return normalizeAsciiPreset(parsed);
  } catch {
    return null;
  }
}

export function saveAsciiPreset(value: unknown): boolean {
  const preset = normalizeAsciiPreset(value);
  if (!preset) return false;

  try {
    window.localStorage.setItem(ASCII_PRESET_STORAGE_KEY, JSON.stringify(preset));
    return true;
  } catch {
    return false;
  }
}
