import { chromium, type Browser, type Page } from 'playwright';
import { inflateSync } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4175;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 812, height: 998 } as const;
const PRESET = {
  version: 2,
  color: true,
  unicode: false,
  glyphSize: 6,
  colorBrightness: 55,
  colorSaturation: 22,
  rotationSpeed: 100,
  defaultTilt: 0,
  autoRotate: true,
  luminanceCurve: [
    { x: 0, y: 0 },
    { x: 0.24, y: 0.13 },
    { x: 0.74, y: 0.36 },
    { x: 0.88, y: 0.74 },
    { x: 1, y: 1 },
  ],
  viewport: {
    cameraPosition: { x: 191.405297, y: 233.558041, z: 2.828215 },
    spinAngle: 155.471442,
    pan: { x: 0.04765, y: 0.271156 },
  },
} as const;

type CaptureMode = {
  name: string;
  renderer: 'dom' | 'gpu';
  sampler: 'canvas' | 'target';
  color: boolean;
  unicode: boolean;
};

const MODES: CaptureMode[] = [
  { name: 'dom-full-color', renderer: 'dom', sampler: 'canvas', color: true, unicode: false },
  { name: 'gpu-full-color', renderer: 'gpu', sampler: 'canvas', color: true, unicode: false },
  { name: 'gpu-bw', renderer: 'gpu', sampler: 'canvas', color: false, unicode: false },
  { name: 'gpu-unicode', renderer: 'gpu', sampler: 'canvas', color: true, unicode: true },
  // Keep this requested legacy target capture in the matrix even while the
  // viewer's compatibility route reports its actual backend in the DOM.
  { name: 'legacy-target', renderer: 'dom', sampler: 'target', color: true, unicode: false },
];

type RgbaImage = { width: number; height: number; data: Uint8Array };
type Bbox = { x: number; y: number; width: number; height: number } | null;
type VisualMetrics = {
  backgroundMedian: number;
  roi: { x: number; y: number; width: number; height: number; gridSize: number };
  threshold: number;
  occupancy: number;
  meanLuma: number;
  meanSaturation: number;
  bbox: Bbox;
  structural: {
    correlation: number | null;
    rmse: number | null;
    flips: Record<'normal' | 'flipX' | 'flipY' | 'flipXY', { correlation: number | null; rmse: number | null }>;
  } | null;
  occupancyRelativeDifference: number | null;
};
type InternalMetrics = VisualMetrics & { signalGrid: number[] };
type CaptureReport = {
  mode: CaptureMode;
  requestedBackend: string;
  actualBackend: string | null;
  path: string;
  consoleErrors: string[];
  metrics: InternalMetrics;
};

const sleep = (durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs));

async function serverIsReady(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/viewer.html`);
    return response.ok;
  } catch {
    return false;
  }
}

async function startServer(): Promise<Bun.Subprocess | undefined> {
  if (await serverIsReady()) return undefined;
  const subprocess = Bun.spawn(
    ['bunx', '--bun', 'vite', '--host', '127.0.0.1', '--port', String(PORT)],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await serverIsReady()) return subprocess;
    await sleep(100);
  }
  subprocess.kill();
  throw new Error(`Vite did not become ready at ${BASE_URL}`);
}

function resolveChromiumExecutable(): string | undefined {
  const requested = Bun.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (requested && existsSync(requested)) return requested;
  const bundled = chromium.executablePath();
  const cacheRootMatch = bundled.match(/^(.*)\/chromium-\d+\//);
  const cacheRoot = cacheRootMatch?.[1];
  const cached = cacheRoot
    ? readdirSync(cacheRoot)
        .filter((entry) => entry.startsWith('chromium_headless_shell-'))
        .sort()
        .reverse()
        .map((entry) => join(cacheRoot, entry, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'))
        .find((candidate) => existsSync(candidate))
    : undefined;
  return cached ?? (existsSync(bundled) ? bundled : undefined);
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function decodePng(bytes: Uint8Array): RgbaImage {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) throw new Error('Invalid PNG signature');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  while (offset < bytes.length) {
    const length = readUInt32(bytes, offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = readUInt32(body, 0);
      height = readUInt32(body, 4);
      bitDepth = body[8];
      colorType = body[9];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += length + 12;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error(`Unsupported screenshot PNG format: depth=${bitDepth} type=${colorType}`);
  const compressed = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  idat.forEach((part) => { compressed.set(part, cursor); cursor += part.length; });
  const raw = new Uint8Array(inflateSync(compressed));
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const output = new Uint8Array(width * height * 4);
  let rawOffset = 0;
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset++];
    const row = raw.subarray(rawOffset, rawOffset + stride);
    rawOffset += stride;
    const decoded = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? decoded[x - channels] : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= channels ? previous[x - channels] : 0;
      const value = row[x];
      decoded[x] = filter === 0 ? value
        : filter === 1 ? (value + left) & 0xff
          : filter === 2 ? (value + up) & 0xff
            : filter === 3 ? (value + Math.floor((left + up) / 2)) & 0xff
              : (value + paeth(left, up, upLeft)) & 0xff;
    }
    previous = decoded;
    const rgba = output.subarray(y * width * 4, (y + 1) * width * 4);
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = x * 4;
      rgba[target] = decoded[source];
      rgba[target + 1] = decoded[source + 1];
      rgba[target + 2] = decoded[source + 2];
      rgba[target + 3] = channels === 4 ? decoded[source + 3] : 255;
    }
  }
  return { width, height, data: output };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function luminance(image: RgbaImage, x: number, y: number): number {
  const offset = (y * image.width + x) * 4;
  return image.data[offset] * 0.2126 + image.data[offset + 1] * 0.7152 + image.data[offset + 2] * 0.0722;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function pearson(left: number[], right: number[]): number | null {
  if (left.length !== right.length || left.length < 2) return null;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  left.forEach((value, index) => {
    const a = value - leftMean;
    const b = right[index] - rightMean;
    numerator += a * b;
    leftVariance += a * a;
    rightVariance += b * b;
  });
  if (leftVariance === 0 || rightVariance === 0) return leftVariance === rightVariance ? 1 : 0;
  return numerator / Math.sqrt(leftVariance * rightVariance);
}

const ROI = { x: 0, y: 70, width: 470, height: 880, gridSize: 64 } as const;

function calculateMetrics(image: RgbaImage): InternalMetrics {
  const background: number[] = [];
  for (let y = 100; y < Math.min(190, image.height); y += 1) {
    for (let x = 20; x < Math.min(150, image.width); x += 1) background.push(luminance(image, x, y));
  }
  const backgroundMedian = median(background);
  const roi = {
    x: ROI.x,
    y: ROI.y,
    width: Math.min(ROI.width, image.width),
    height: Math.min(ROI.height, image.height - ROI.y),
    gridSize: ROI.gridSize,
  };
  const threshold = backgroundMedian + 6;
  let occupied = 0;
  let lumaTotal = 0;
  let saturationTotal = 0;
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  const signalGrid = Array.from({ length: roi.gridSize * roi.gridSize }, () => 0);
  const gridCounts = Array.from({ length: roi.gridSize * roi.gridSize }, () => 0);
  for (let y = roi.y; y < roi.y + roi.height; y += 1) {
    for (let x = roi.x; x < roi.x + roi.width; x += 1) {
      const value = luminance(image, x, y);
      const offset = (y * image.width + x) * 4;
      const maximum = Math.max(image.data[offset], image.data[offset + 1], image.data[offset + 2]);
      const minimum = Math.min(image.data[offset], image.data[offset + 1], image.data[offset + 2]);
      lumaTotal += value;
      saturationTotal += maximum === 0 ? 0 : (maximum - minimum) / maximum;
      const signal = Math.max(0, value - backgroundMedian);
      const gridX = Math.min(roi.gridSize - 1, Math.floor(((x - roi.x) / roi.width) * roi.gridSize));
      const gridY = Math.min(roi.gridSize - 1, Math.floor(((y - roi.y) / roi.height) * roi.gridSize));
      const gridOffset = gridY * roi.gridSize + gridX;
      signalGrid[gridOffset] += signal;
      gridCounts[gridOffset] += 1;
      if (value > threshold) {
        occupied += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  const area = roi.width * roi.height;
  const bbox = maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  signalGrid.forEach((sum, index) => { signalGrid[index] = gridCounts[index] ? sum / gridCounts[index] : 0; });
  return {
    backgroundMedian,
    roi,
    threshold,
    occupancy: area ? occupied / area : 0,
    meanLuma: area ? lumaTotal / area : 0,
    meanSaturation: area ? saturationTotal / area : 0,
    bbox,
    structural: null,
    occupancyRelativeDifference: null,
    signalGrid,
  };
}

function compareGrids(reference: number[], candidate: number[], size: number): { correlation: number | null; rmse: number | null } {
  const squared = candidate.reduce((sum, value, index) => sum + (value - reference[index]) ** 2, 0);
  return { correlation: pearson(reference, candidate), rmse: Math.sqrt(squared / Math.max(1, candidate.length)) };
}

function compareStructural(reference: number[], candidate: number[], size: number): VisualMetrics['structural'] {
  const flip = (horizontal: boolean, vertical: boolean): number[] => Array.from({ length: size * size }, (_, index) => {
    const x = index % size;
    const y = Math.floor(index / size);
    const sourceX = horizontal ? size - x - 1 : x;
    const sourceY = vertical ? size - y - 1 : y;
    return candidate[sourceY * size + sourceX];
  });
  return {
    ...compareGrids(reference, candidate, size),
    flips: {
      normal: compareGrids(reference, candidate, size),
      flipX: compareGrids(reference, flip(true, false), size),
      flipY: compareGrids(reference, flip(false, true), size),
      flipXY: compareGrids(reference, flip(true, true), size),
    },
  };
}

async function configurePage(page: Page, mode: CaptureMode): Promise<void> {
  await page.locator('#viewer-stage.is-ready').waitFor({ state: 'attached', timeout: 30_000 });
  const asciiToggle = page.locator('#ascii-toggle');
  if ((await asciiToggle.getAttribute('aria-pressed')) !== 'true') await asciiToggle.click();
  await page.locator('#ascii-toggle[aria-pressed="true"]').waitFor({ state: 'attached' });
  const rotateToggle = page.locator('#rotate-toggle');
  if ((await rotateToggle.getAttribute('aria-pressed')) === 'true') await rotateToggle.click();
  if (!mode.color) await page.locator('#ascii-color-toggle').click();
  if (mode.unicode) await page.locator('#ascii-charset-toggle').click();
  await page.locator('#reset-view').click();
  await sleep(1_300);
  // Capture the renderer surface without fixed controls/header occluding the
  // model ROI. The page remains at the exact benchmark viewport.
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>('.viewer-header, .ascii-controls, .viewer-meta, .viewer-hint')
      .forEach((element) => { element.style.visibility = 'hidden'; });
  });
}

async function main(): Promise<void> {
  let server: Bun.Subprocess | undefined;
  let browser: Browser | undefined;
  const outputDir = mkdtempSync(join(tmpdir(), 'ascii-visual-'));
  const captures: CaptureReport[] = [];
  try {
    server = await startServer();
    const executablePath = resolveChromiumExecutable();
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    for (const mode of MODES) {
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      await context.addInitScript((preset) => {
        window.localStorage.setItem('milo-ascii-home-preset-v1', JSON.stringify(preset));
      }, PRESET);
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
      await page.goto(`${BASE_URL}/viewer.html?profile=1&asciiSampler=${mode.sampler}&asciiRenderer=${mode.renderer}`, { waitUntil: 'networkidle', timeout: 30_000 });
      await configurePage(page, mode);
      const path = join(outputDir, `${mode.name}.png`);
      await page.locator('#viewer-stage').screenshot({ path });
      const image = decodePng(new Uint8Array(readFileSync(path)));
      captures.push({
        mode,
        requestedBackend: mode.sampler,
        actualBackend: await page.locator('#ascii-profile').getAttribute('data-profile-backend'),
        path,
        consoleErrors,
        metrics: calculateMetrics(image),
      });
      await context.close();
    }
  } finally {
    await browser?.close();
    server?.kill();
  }

  const baselineCapture = captures.find((capture) => capture.mode.name === 'dom-full-color');
  captures.forEach((capture) => {
    if (baselineCapture) {
      capture.metrics.structural = compareStructural(
        baselineCapture.metrics.signalGrid,
        capture.metrics.signalGrid,
        ROI.gridSize,
      );
      capture.metrics.occupancyRelativeDifference = baselineCapture.metrics.occupancy === 0
        ? null
        : Math.abs(capture.metrics.occupancy - baselineCapture.metrics.occupancy) / baselineCapture.metrics.occupancy;
    }
  });
  const gpuColor = captures.find((capture) => capture.mode.name === 'gpu-full-color');
  const gpuBw = captures.find((capture) => capture.mode.name === 'gpu-bw');
  const contaminationPass = !!gpuColor && !!gpuBw
    && gpuColor.metrics.backgroundMedian <= 1
    && gpuBw.metrics.backgroundMedian <= 1;
  const fullColorParityPass = !!gpuColor
    && (gpuColor.metrics.structural?.correlation ?? 0) >= 0.75
    && (gpuColor.metrics.occupancyRelativeDifference ?? Infinity) <= 0.25;
  const sanityPass = !!gpuBw && !!captures.find((capture) => capture.mode.name === 'gpu-unicode')
    && gpuBw.metrics.occupancy > 0
    && (captures.find((capture) => capture.mode.name === 'gpu-unicode')?.metrics.occupancy ?? 0) > 0;
  const consoleErrors = captures.flatMap((capture) => capture.consoleErrors.map((error) => `${capture.mode.name}: ${error}`));
  const serializableCaptures = captures.map((capture) => {
    const { signalGrid: _signalGrid, ...metrics } = capture.metrics;
    return { ...capture, metrics };
  });
  const report = {
    command: 'bun run compare:ascii:visual',
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    preset: PRESET,
    exactView: PRESET.viewport,
    captures: serializableCaptures,
    contamination: {
      gpuColorBackgroundMedian: gpuColor?.metrics.backgroundMedian ?? null,
      gpuBwBackgroundMedian: gpuBw?.metrics.backgroundMedian ?? null,
      threshold: 1,
      pass: contaminationPass,
    },
    parity: {
      fullColor: { correlationMinimum: 0.75, occupancyRelativeDifferenceMaximum: 0.25, pass: fullColorParityPass },
      bwUnicodeSanity: { pass: sanityPass },
    },
    consoleErrors,
    pass: contaminationPass && fullColorParityPass && sanityPass && consoleErrors.length === 0,
  };
  console.log(JSON.stringify(report, null, 2));
  console.log(`visual-contamination=${report.pass ? 'PASS' : 'FAIL'} (GPU color/B&W background median <= 1; full-color corr >= .75; occupancy delta <= 25%)`);
  for (const capture of captures) {
    const metrics = capture.metrics;
    const bbox = metrics.bbox ? `${metrics.bbox.x},${metrics.bbox.y},${metrics.bbox.width}x${metrics.bbox.height}` : 'none';
    console.log(`${capture.mode.name}: backgroundMedian=${metrics.backgroundMedian.toFixed(2)} occupancy=${metrics.occupancy.toFixed(4)} meanLuma=${metrics.meanLuma.toFixed(2)} saturation=${metrics.meanSaturation.toFixed(4)} correlation=${metrics.structural?.correlation?.toFixed(4) ?? 'n/a'} rmse=${metrics.structural?.rmse?.toFixed(2) ?? 'n/a'} bbox=${bbox} path=${capture.path}`);
  }
  if (!report.pass) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
