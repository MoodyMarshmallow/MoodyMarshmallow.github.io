import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 4177;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const HEIGHT = 800;
const WIDTHS = [360, 599, 600, 601, 1080] as const;

const executable = (() => {
  const requested = Bun.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (requested && existsSync(requested)) return requested;
  const root = '/Users/milo/Library/Caches/ms-playwright';
  const bundledChromium = existsSync(root)
    ? readdirSync(root)
      .filter((entry) => entry.startsWith('chromium_headless_shell-'))
      .sort()
      .reverse()
      .map((entry) => join(root, entry, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'))
      .find((path) => existsSync(path))
    : undefined;
  if (bundledChromium) return bundledChromium;
  return [
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    join(Bun.env.HOME ?? '', 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser'),
  ].find((path) => existsSync(path));
})();

type ElementMeasurement = {
  visible: boolean;
  fontSize: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

type Measurement = {
  width: number;
  title: ElementMeasurement;
  intro: ElementMeasurement;
  heroHeight: number;
  heroTop: number;
  heroBottom: number;
  documentScrollWidth: number;
};

async function waitForServer(server: Bun.Subprocess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Vite exited before becoming ready (code ${server.exitCode}).`);
    }
    try {
      if ((await fetch(BASE_URL)).ok) {
        await Bun.sleep(50);
        if (server.exitCode !== null) {
          throw new Error(`Vite exited during startup (code ${server.exitCode}); port ${PORT} may already be in use.`);
        }
        return;
      }
    } catch {
      // Vite is still starting.
    }
    await Bun.sleep(50);
  }
  throw new Error(`Vite did not start at ${BASE_URL}.`);
}

async function main(): Promise<void> {
  const server = Bun.spawn(
    ['bunx', '--bun', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: import.meta.dir + '/..', stdout: 'ignore', stderr: 'ignore' },
  );

  try {
    await waitForServer(server);
    const browser = await chromium.launch({
      headless: true,
      ...(executable ? { executablePath: executable } : {}),
    });
    const page = await browser.newPage({ viewport: { width: WIDTHS[0], height: HEIGHT } });
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const title = document.querySelector('.homepage-title');
      const intro = document.querySelector('.homepage-intro');
      if (!title || !intro) return false;
      const titleRect = title.getBoundingClientRect();
      const introRect = intro.getBoundingClientRect();
      return titleRect.width > 0 && titleRect.height > 0 && introRect.width > 0 && introRect.height > 0;
    });
    await page.evaluate(() => document.fonts.ready);

    const measurements: Measurement[] = [];
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHT });
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      measurements.push(await page.evaluate((viewportWidth) => {
        const title = document.querySelector('.homepage-title');
        const intro = document.querySelector('.homepage-intro');
        const hero = document.querySelector('.homepage-hero');
        if (!(title instanceof HTMLElement) || !(intro instanceof HTMLElement) || !(hero instanceof HTMLElement)) {
          throw new Error('Semantic homepage hero is incomplete.');
        }
        const measure = (element: HTMLElement): ElementMeasurement => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            visible: style.display !== 'none'
              && style.visibility !== 'hidden'
              && Number.parseFloat(style.opacity || '1') > 0
              && rect.width > 0
              && rect.height > 0,
            fontSize: Number.parseFloat(style.fontSize),
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          };
        };
        const heroRect = hero.getBoundingClientRect();
        return {
          width: viewportWidth,
          title: measure(title),
          intro: measure(intro),
          heroHeight: heroRect.height,
          heroTop: heroRect.top,
          heroBottom: heroRect.bottom,
          documentScrollWidth: document.documentElement.scrollWidth,
        };
      }, width));
    }
    await browser.close();

    const breakpointRows = measurements.filter(({ width }) => width >= 599 && width <= 601);
    const adjacentDeltas = breakpointRows.slice(1).map((row, index) => ({
      from: breakpointRows[index].width,
      to: row.width,
      titleFontSize: Math.abs(row.title.fontSize - breakpointRows[index].title.fontSize),
      introFontSize: Math.abs(row.intro.fontSize - breakpointRows[index].intro.fontSize),
      titleLeft: Math.abs(row.title.left - breakpointRows[index].title.left),
      introLeft: Math.abs(row.intro.left - breakpointRows[index].intro.left),
      titleTop: Math.abs(row.title.top - breakpointRows[index].title.top),
    }));
    const narrow = measurements.find(({ width }) => width === 360)!;
    const desktop = measurements.find(({ width }) => width === 1080)!;
    const checks = {
      titleAndIntroVisible: measurements.every(({ title, intro }) => title.visible && intro.visible),
      titleTypographyContinuousAt600: adjacentDeltas.every(({ titleFontSize }) => titleFontSize <= 0.25),
      introTypographyContinuousAt600: adjacentDeltas.every(({ introFontSize }) => introFontSize <= 0.25),
      titleLeftEdgeContinuousAt600: adjacentDeltas.every(({ titleLeft }) => titleLeft <= 8),
      introLeftEdgeContinuousAt600: adjacentDeltas.every(({ introLeft }) => introLeft <= 8),
      titleTopPaddingStableAt600: adjacentDeltas.every(({ titleTop }) => titleTop <= 2),
      introDirectlyBelowTitle: measurements.every(({ title, intro }) => {
        const gap = intro.top - title.bottom;
        return gap >= 0 && gap <= 64;
      }),
      heroAtLeastOneViewport: measurements.every(({ heroHeight }) => heroHeight >= HEIGHT - 1),
      heroStartsAtDocumentTop: measurements.every(({ heroTop }) => Math.abs(heroTop) <= 1),
      titleInUpperFirstViewport: measurements.every(({ title }) => {
        const centerY = title.top + title.height / 2;
        return title.top >= 16 && centerY <= HEIGHT * 0.45;
      }),
      copyHasReasonableViewportPadding: measurements.every(({ width, title, intro }) => (
        title.left >= 16
        && intro.left >= 16
        && Math.max(title.right, intro.right) <= width - 16
        && intro.bottom <= HEIGHT - 16
      )),
      noHorizontalOverflow: measurements.every(({ width, documentScrollWidth }) => documentScrollWidth <= width + 1),
      narrowCopyFits: narrow.title.width <= narrow.width - 32 && narrow.intro.width <= narrow.width - 32,
      desktopCopyFits: desktop.title.width <= desktop.width - 32 && desktop.intro.width <= desktop.width - 32,
      heroCoversFirstViewport: measurements.every(({ heroBottom }) => heroBottom >= HEIGHT - 1),
    };

    console.log(JSON.stringify({ measurements, adjacentDeltas, checks }, null, 2));
    if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
  } finally {
    server.kill();
    await server.exited;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
