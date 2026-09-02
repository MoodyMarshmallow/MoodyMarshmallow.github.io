import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 4175;
const VIEWPORT = { width: 812, height: 998 } as const;
const SIZES = [2, 4, 6, 8, 10, 18] as const;
const PRESET = {
  version: 2, color: true, unicode: false, glyphSize: 6, colorBrightness: 55, colorSaturation: 22,
  rotationSpeed: 100, defaultTilt: 0, autoRotate: false, luminanceCurve: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  viewport: { cameraPosition: { x: 191.405297, y: 233.558041, z: 2.828215 }, spinAngle: 155.471442, pan: { x: 0.04765, y: 0.271156 } },
};

const executable = (() => {
  const requested = Bun.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (requested && existsSync(requested)) return requested;
  const root = '/Users/milo/Library/Caches/ms-playwright';
  return readdirSync(root).filter((entry) => entry.startsWith('chromium_headless_shell-')).sort().reverse()
    .map((entry) => join(root, entry, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'))
    .find((path) => existsSync(path));
})();

async function main(): Promise<void> {
  let server: Bun.Subprocess | undefined;
  try {
    await fetch(`http://127.0.0.1:${PORT}/viewer.html`);
  } catch {
    server = Bun.spawn(['bunx', '--bun', 'vite', '--host', '127.0.0.1', '--port', String(PORT)], { stdout: 'ignore', stderr: 'ignore' });
    for (let attempt = 0; attempt < 150; attempt += 1) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/viewer.html`)).ok) break; } catch { /* keep polling */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const browser = await chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}) });
  const rows: Array<Record<string, unknown>> = [];
  for (const renderer of ['dom', 'gpu'] as const) {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await context.addInitScript((preset) => localStorage.setItem('milo-ascii-home-preset-v1', JSON.stringify(preset)), PRESET);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${PORT}/viewer.html?profile=1&asciiRenderer=${renderer}`, { waitUntil: 'networkidle' });
    await page.locator('#viewer-stage.is-ready').waitFor({ state: 'attached', timeout: 30_000 });
    await page.locator('#ascii-toggle').click();
    for (const size of SIZES) {
      await page.locator('#ascii-size').evaluate((input, value) => {
        const element = input as HTMLInputElement;
        element.value = String(value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }, size);
      await page.waitForTimeout(180);
      const row = await page.locator('#ascii-profile').evaluate((element, value) => {
        const columns = Number(element.getAttribute('data-profile-sample-width')) || 0;
        const pitch = Number(element.getAttribute('data-profile-horizontal-pitch')) || 0;
        return { renderer: value.renderer, glyphSize: value.size, columns, pitch, coverage: columns * pitch, errors: value.errors };
      }, { renderer, size, errors });
      rows.push(row);
    }
    await context.close();
  }
  await browser.close();
  server?.kill();
  console.log(JSON.stringify(rows, null, 2));
  if (rows.some((row) => Number(row.coverage) < VIEWPORT.width - 1 || (row.errors as string[]).length > 0)) process.exitCode = 1;
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
