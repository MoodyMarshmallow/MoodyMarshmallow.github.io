import { chromium, type Browser, type Page } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 4175;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 812, height: 998 } as const;
const FPS_SAMPLE_COUNT = 3;
const SAMPLE_INTERVAL_MS = 1_050;
const INITIAL_SAMPLE_DELAY_MS = 1_150;
const PHASE_TIMEOUT_MS = INITIAL_SAMPLE_DELAY_MS + SAMPLE_INTERVAL_MS * (FPS_SAMPLE_COUNT + 1);
const SAMPLER = Bun.env.ASCII_SAMPLER === 'target' ? 'target' : 'canvas';
const ASCII_RENDERER = Bun.env.ASCII_RENDERER === 'gpu' ? 'gpu' : 'dom';
const PROFILE_METRICS = [
  'lit-webgl-render',
  'lit-readback',
  'unlit-material-color-render',
  'color-readback',
  'glyph-color-string-loop',
  'dom-innerhtml-commit',
  'target-lit-render',
  'target-lit-output-pass',
  'target-lit-readback',
  'target-unlit-material-color-render',
  'target-color-output-pass',
  'target-pack-pass',
  'target-packed-readback',
  'gpu-lit-render',
  'gpu-unlit-render',
  'gpu-glyph-pass',
  'total',
] as const;

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

type PhaseName = 'idle auto-rotation' | 'left-button orbit drag' | 'right-button pan drag';
type ProfileMetric = (typeof PROFILE_METRICS)[number];

type ProfileAggregate = {
  mean: number;
  p95: number;
};

type PhaseReport = {
  name: PhaseName;
  samples: number[];
  min: number;
  mean: number;
  max: number;
  pass: boolean;
  profile: {
    backend: string | null;
    sampleCount: number;
    metrics: Record<ProfileMetric, ProfileAggregate>;
    occupiedGlyphs: {
      samples: number[];
      min: number;
      mean: number;
      max: number;
    };
  };
};

type BenchmarkReport = {
  command: string;
  backend: string;
  renderer: string;
  viewport: typeof VIEWPORT;
  settings: Record<string, unknown>;
  phases: PhaseReport[];
  consoleErrors: string[];
  pass: boolean;
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

async function readFps(page: Page): Promise<number | null> {
  const fps = page.locator('#ascii-fps');
  if ((await fps.getAttribute('data-fps-ready')) !== 'true') return null;
  const value = Number(await fps.getAttribute('data-fps-value'));
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function resetProfile(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('ascii-profile-reset')));
}

async function readProfile(page: Page): Promise<PhaseReport['profile']> {
  const profile = page.locator('#ascii-profile');
  const backend = await profile.getAttribute('data-profile-backend');
  const sampleCount = Number(await profile.getAttribute('data-profile-sample-count')) || 0;
  const occupiedSamples = (await profile.getAttribute('data-profile-occupied-samples') ?? '')
    .split(',')
    .filter((value) => value.length > 0)
    .map(Number)
    .filter(Number.isFinite);
  const metrics = Object.fromEntries(
    await Promise.all(PROFILE_METRICS.map(async (metric) => {
      const prefix = backend === 'gpu' && metric.startsWith('gpu-')
        ? `data-profile-${metric}`
        : backend === 'gpu'
          ? `data-profile-gpu-${metric}`
          : `data-profile-${metric}`;
      const mean = Number(await profile.getAttribute(`${prefix}-mean`)) || 0;
      const p95 = Number(await profile.getAttribute(`${prefix}-p95`)) || 0;
      return [metric, { mean, p95 }];
    })),
  ) as Record<ProfileMetric, ProfileAggregate>;
  const min = occupiedSamples.length > 0 ? Math.min(...occupiedSamples) : 0;
  const max = occupiedSamples.length > 0 ? Math.max(...occupiedSamples) : 0;
  const mean = occupiedSamples.length > 0
    ? occupiedSamples.reduce((sum, value) => sum + value, 0) / occupiedSamples.length
    : 0;
  return { backend, sampleCount, metrics, occupiedGlyphs: { samples: occupiedSamples, min, mean, max } };
}

async function holdDrag(page: Page, button: 'left' | 'right', deltaX: number, deltaY: number): Promise<void> {
  const startX = VIEWPORT.width / 2;
  const startY = VIEWPORT.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button });
  const end = Date.now() + PHASE_TIMEOUT_MS;
  let step = 0;
  try {
    while (Date.now() < end) {
      step += 1;
      await page.mouse.move(startX + ((step * deltaX) % 180), startY + ((step * deltaY) % 120));
      await sleep(100);
    }
  } finally {
    await page.mouse.up({ button });
  }
}

async function samplePhase(page: Page, name: PhaseName, interaction?: () => Promise<void>): Promise<PhaseReport> {
  const samples: number[] = [];
  const interactionPromise = interaction?.();
  await sleep(INITIAL_SAMPLE_DELAY_MS);
  const deadline = Date.now() + PHASE_TIMEOUT_MS;
  while (samples.length < FPS_SAMPLE_COUNT && Date.now() < deadline) {
    const value = await readFps(page);
    if (value !== null) samples.push(value);
    if (samples.length < FPS_SAMPLE_COUNT) await sleep(SAMPLE_INTERVAL_MS);
  }
  await interactionPromise;

  const min = samples.length > 0 ? Math.min(...samples) : 0;
  const max = samples.length > 0 ? Math.max(...samples) : 0;
  const mean = samples.length > 0 ? samples.reduce((sum, sample) => sum + sample, 0) / samples.length : 0;
  const pass = samples.length >= FPS_SAMPLE_COUNT && mean >= 30 && min >= 27;
  return {
    name,
    samples,
    min,
    mean,
    max,
    pass,
    profile: {
      backend: null,
      sampleCount: 0,
      metrics: {} as Record<ProfileMetric, ProfileAggregate>,
      occupiedGlyphs: { samples: [], min: 0, mean: 0, max: 0 },
    },
  };
}

async function runPhase(page: Page, name: PhaseName, interaction?: () => Promise<void>): Promise<PhaseReport> {
  await page.evaluate(() => window.dispatchEvent(new Event('ascii-viewport-restore')));
  await sleep(200);
  await resetProfile(page);
  const report = await samplePhase(page, name, interaction);
  report.profile = await readProfile(page);
  return report;
}

async function readSettings(page: Page): Promise<Record<string, unknown>> {
  const value = async (selector: string) => page.locator(selector).inputValue();
  return {
    color: (await page.locator('#ascii-color-toggle').textContent())?.trim() ?? null,
    charset: (await page.locator('#ascii-charset-toggle').textContent())?.trim() ?? null,
    glyphSize: await value('#ascii-size'),
    brightness: await value('#ascii-brightness'),
    saturation: await value('#ascii-saturation'),
    rotationSpeed: await value('#rotation-speed'),
    defaultTilt: await value('#default-tilt'),
    autoRotate: (await page.locator('#rotate-toggle').getAttribute('aria-pressed')) === 'true',
    renderMode: (await page.locator('#render-mode-label').textContent())?.trim() ?? null,
    samplingBackend: await page.locator('#ascii-profile').getAttribute('data-profile-backend'),
    asciiRenderer: ASCII_RENDERER,
    luminanceCurve: PRESET.luminanceCurve,
  };
}

function resolveChromiumExecutable(): string | undefined {
  const requested = Bun.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (requested && existsSync(requested)) return requested;

  const bundled = chromium.executablePath();
  // Playwright's browser cache can contain a nearby build when the pinned
  // headless-shell download is unavailable. Use the newest compatible shell.
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

async function main(): Promise<void> {
  let server: Bun.Subprocess | undefined;
  let browser: Browser | undefined;
  const consoleErrors: string[] = [];
  try {
    server = await startServer();
    const executablePath = resolveChromiumExecutable();
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const context = await browser.newContext({ viewport: VIEWPORT });
    await context.addInitScript((preset) => {
      window.localStorage.setItem('milo-ascii-home-preset-v1', JSON.stringify(preset));
    }, PRESET);
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
    await page.goto(`${BASE_URL}/viewer.html?profile=1&asciiSampler=${SAMPLER}&asciiRenderer=${ASCII_RENDERER}`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.locator('#viewer-stage.is-ready').waitFor({ state: 'attached', timeout: 30_000 });

    const asciiToggle = page.locator('#ascii-toggle');
    if ((await asciiToggle.getAttribute('aria-pressed')) !== 'true') await asciiToggle.click();
    await page.locator('#ascii-fps[data-fps-state="active"]').waitFor({ state: 'attached', timeout: 10_000 });
    await page.locator('#ascii-profile[data-profile-enabled="true"]').waitFor({ state: 'attached', timeout: 10_000 });

    const phases: PhaseReport[] = [
      await runPhase(page, 'idle auto-rotation'),
      await runPhase(page, 'left-button orbit drag', () => holdDrag(page, 'left', 9, 3)),
      await runPhase(page, 'right-button pan drag', () => holdDrag(page, 'right', 5, -4)),
    ];
    const report: BenchmarkReport = {
      command: 'bun run benchmark:ascii',
      backend: SAMPLER,
      renderer: ASCII_RENDERER,
      viewport: VIEWPORT,
      settings: await readSettings(page),
      phases,
      consoleErrors,
      pass: phases.every((phase) => phase.pass),
    };
    console.log(JSON.stringify(report, null, 2));
    console.log('\nASCII benchmark summary');
    for (const phase of phases) {
      console.log(
        `${phase.pass ? 'PASS' : 'FAIL'} ${phase.name}: ` +
          `samples=${phase.samples.join(', ')} min=${phase.min.toFixed(1)} ` +
          `mean=${phase.mean.toFixed(1)} max=${phase.max.toFixed(1)}`,
      );
      const timing = PROFILE_METRICS.map((metric) => {
        const aggregate = phase.profile.metrics[metric];
        return `${metric}=${aggregate.mean.toFixed(3)}ms/p95:${aggregate.p95.toFixed(3)}ms`;
      }).join(' ');
      console.log(`  profile backend=${phase.profile.backend ?? 'unknown'} samples=${phase.profile.sampleCount} ${timing}`);
      const occupied = phase.profile.occupiedGlyphs;
      console.log(
        `  occupied-glyphs samples=${occupied.samples.length} ` +
          `min=${occupied.min.toFixed(1)} mean=${occupied.mean.toFixed(1)} max=${occupied.max.toFixed(1)}`,
      );
    }
    console.log(`quality=${report.pass ? 'PASS' : 'FAIL'} (mean >= 30 FPS; no sample < 27 FPS)`);
    if (!report.pass) process.exitCode = 1;
  } finally {
    await browser?.close();
    server?.kill();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
