import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const PORT = 4176;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CACHED_CHROMIUM = '/Users/milo/Library/Caches/ms-playwright/chromium_headless_shell-1232/chrome-headless-shell-mac-arm64/chrome-headless-shell';

const preset = {
  version: 2,
  color: true,
  unicode: false,
  glyphSize: 6,
  colorBrightness: 55,
  colorSaturation: 22,
  rotationSpeed: 100,
  defaultTilt: 0,
  autoRotate: false,
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
};

function hash(bytes: Buffer): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}

async function captureStableHash(locator: ReturnType<import('playwright').Page['locator']>): Promise<string> {
  let previous = '';
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const current = hash(await locator.screenshot());
    if (current === previous) return current;
    previous = current;
    await Bun.sleep(100);
  }
  throw new Error('GPU canvas did not reach a stable frame.');
}

const server = Bun.spawn(
  ['bunx', '--bun', 'vite', '--host', '127.0.0.1', '--port', String(PORT)],
  { cwd: import.meta.dir + '/..', stdout: 'ignore', stderr: 'inherit' },
);

try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/viewer.html`);
      if (response.ok) break;
    } catch {
      // Vite is still starting.
    }
    await Bun.sleep(50);
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath: existsSync(CACHED_CHROMIUM) ? CACHED_CHROMIUM : undefined,
  });
  const context = await browser.newContext({ viewport: { width: 812, height: 998 } });
  await context.addInitScript((value) => {
    localStorage.setItem('milo-ascii-home-preset-v1', JSON.stringify(value));
  }, preset);
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/viewer.html?asciiRenderer=gpu&profile=1`, { waitUntil: 'networkidle' });
  await page.locator('#viewer-stage.is-ready').waitFor();

  const asciiToggle = page.locator('#ascii-toggle');
  if (await asciiToggle.getAttribute('aria-pressed') !== 'true') await asciiToggle.click();
  const rotateToggle = page.locator('#rotate-toggle');
  if (await rotateToggle.getAttribute('aria-pressed') === 'true') await rotateToggle.click();
  await page.locator('#reset-view').click();

  const canvas = page.locator('#viewer-stage canvas');
  const stableBefore = await captureStableHash(canvas);

  const curvePath = page.locator('#curve-path');
  const profile = page.locator('#ascii-profile');
  const pathBefore = await curvePath.getAttribute('d');
  const textureVersionBefore = Number(await profile.getAttribute('data-profile-curve-texture-version'));
  const pointsBefore = await page.locator('#curve-points circle').count();
  const plotBounds = await page.locator('.curve-graph__plot').boundingBox();
  if (!plotBounds) throw new Error('Curve plot is not visible.');
  await page.mouse.click(plotBounds.x + plotBounds.width * 0.5, plotBounds.y + 4);

  const pathAfter = await curvePath.getAttribute('d');
  const textureVersionAfter = Number(await profile.getAttribute('data-profile-curve-texture-version'));
  const pointsAfter = await page.locator('#curve-points circle').count();
  const stableAfter = await captureStableHash(canvas);
  const result = {
    graphChanged: pathBefore !== pathAfter && pointsAfter === pointsBefore + 2,
    gpuTextureUpdated: textureVersionAfter > textureVersionBefore,
    renderChanged: stableBefore !== stableAfter,
    hashes: { stableBefore, stableAfter },
    points: { before: pointsBefore, after: pointsAfter },
    textureVersions: { before: textureVersionBefore, after: textureVersionAfter },
  };
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  if (!result.graphChanged || !result.gpuTextureUpdated || !result.renderChanged) process.exitCode = 1;
} finally {
  server.kill();
  await server.exited;
}
