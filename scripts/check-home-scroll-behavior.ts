import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 4178;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const brave = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';

async function waitForServer(server: Bun.Subprocess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Vite exited with code ${server.exitCode}.`);
    try {
      if ((await fetch(BASE_URL)).ok) return;
    } catch {
      // Vite is still starting.
    }
    await Bun.sleep(50);
  }
  throw new Error('Vite did not become ready.');
}

type SnapState = {
  rootSnapType: string;
  heroAlign: string;
  heroStop: string;
  anchorAlignments: string[];
  anchorStops: string[];
  experienceTargetY: number;
  renderSaturation: string;
};

async function main(): Promise<void> {
  const server = Bun.spawn(
    ['bunx', '--bun', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: import.meta.dir + '/..', stdout: 'ignore', stderr: 'ignore' },
  );

  try {
    await waitForServer(server);
    const browser = await chromium.launch({
      headless: true,
      ...(existsSync(brave) ? { executablePath: brave } : {}),
    });
    const page = await browser.newPage({ viewport: { width: 1080, height: 800 } });
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(350);

    const desktopState = await page.evaluate<SnapState>(() => {
      const hero = document.querySelector<HTMLElement>('.homepage-hero');
      const sections = [...document.querySelectorAll<HTMLElement>('.content-section')];
      const anchors = [...document.querySelectorAll<HTMLElement>('.section-snap-anchor')];
      const experience = sections[0];
      if (!hero || !experience || anchors.length !== sections.length) {
        throw new Error('Homepage snap targets are missing.');
      }
      return {
        rootSnapType: getComputedStyle(document.documentElement).scrollSnapType,
        heroAlign: getComputedStyle(hero).scrollSnapAlign,
        heroStop: getComputedStyle(hero).scrollSnapStop,
        anchorAlignments: anchors.map((anchor) => getComputedStyle(anchor).scrollSnapAlign),
        anchorStops: anchors.map((anchor) => getComputedStyle(anchor).scrollSnapStop),
        experienceTargetY: experience.offsetTop + experience.offsetHeight / 2 - innerHeight / 2,
        renderSaturation: document.querySelector<HTMLElement>('.ascii-stage')?.dataset.renderSaturation ?? '',
      };
    });

    const saturationStates = await page.evaluate(async (experienceTargetY) => {
      const root = document.documentElement;
      const stage = document.querySelector<HTMLElement>('.ascii-stage');
      if (!stage) throw new Error('ASCII stage is missing.');
      // Disable native snapping while sampling the continuous interpolation.
      root.style.scrollSnapType = 'none';
      window.scrollTo(0, 0);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const top = Number(stage.dataset.renderSaturation ?? NaN);
      window.scrollTo(0, experienceTargetY / 2);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const halfway = Number(stage.dataset.renderSaturation ?? NaN);
      window.scrollTo(0, experienceTargetY);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const experience = Number(stage.dataset.renderSaturation ?? NaN);
      window.scrollTo(0, 0);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const restoredTop = Number(stage.dataset.renderSaturation ?? NaN);
      root.style.removeProperty('scroll-snap-type');
      return { top, halfway, experience, restoredTop };
    }, desktopState.experienceTargetY);

    await page.mouse.move(120, 420);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(900);
    const afterDownwardGesture = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(900);
    const afterUpwardGesture = await page.evaluate(() => window.scrollY);

    const mobileContext = await browser.newContext({
      viewport: { width: 820, height: 1_180 },
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
      hasTouch: true,
      isMobile: true,
    });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    const mobileSnapType = await mobilePage.evaluate(
      () => getComputedStyle(document.documentElement).scrollSnapType,
    );
    await mobilePage.evaluate(() => window.scrollTo(0, 200));
    await mobilePage.waitForTimeout(700);
    const mobileState = await mobilePage.evaluate(() => ({
      scrollY: window.scrollY,
      helpHidden: document.querySelector('.viewport-help')?.hasAttribute('hidden') ?? false,
      stagePointerEvents: getComputedStyle(document.querySelector('.ascii-stage')!).pointerEvents,
    }));
    await mobileContext.close();
    await browser.close();

    const checks = {
      desktopUsesMandatoryVerticalSnap: desktopState.rootSnapType.includes('y mandatory'),
      heroSnapsToTop: desktopState.heroAlign === 'start' && desktopState.heroStop === 'always',
      contentSnapsToCenter: desktopState.anchorAlignments.every((value) => value === 'center')
        && desktopState.anchorStops.every((value) => value === 'always'),
      saturationStartsAtFull: Math.abs(saturationStates.top - 1) <= 0.01,
      saturationInterpolatesAtHalfway: Math.abs(saturationStates.halfway - 0.5) <= 0.03,
      saturationReachesZeroAtExperience: Math.abs(saturationStates.experience) <= 0.01,
      saturationRestoresAtTop: Math.abs(saturationStates.restoredTop - 1) <= 0.01,
      downwardGestureCentersExperience: Math.abs(afterDownwardGesture - desktopState.experienceTargetY) <= 4,
      upwardGestureReturnsToTop: afterUpwardGesture <= 1,
      mobileKeepsNativeScrolling: mobileSnapType === 'none'
        && mobileState.scrollY > 150
        && mobileState.helpHidden
        && mobileState.stagePointerEvents === 'none',
    };

    console.log(JSON.stringify({
      desktopState,
      afterDownwardGesture,
      afterUpwardGesture,
      saturationStates,
      mobileSnapType,
      mobileState,
      checks,
    }, null, 2));
    if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
  } finally {
    server.kill();
    await server.exited;
  }
}

await main();
