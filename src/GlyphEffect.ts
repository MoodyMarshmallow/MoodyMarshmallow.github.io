import * as THREE from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

export type LuminancePoint = { x: number; y: number };

export interface GlyphEffectOptions {
  color?: boolean;
  colorBrightness?: number;
  colorSaturation?: number;
  resolution?: number;
  luminanceCurve?: LuminancePoint[];
  samplingBackend?: 'canvas' | 'target';
}

type ProfileMetric =
  | 'lit-webgl-render'
  | 'lit-readback'
  | 'unlit-material-color-render'
  | 'color-readback'
  | 'glyph-color-string-loop'
  | 'dom-innerhtml-commit'
  | 'target-lit-render'
  | 'target-lit-output-pass'
  | 'target-unlit-material-color-render'
  | 'target-color-output-pass'
  | 'target-lit-readback'
  | 'target-pack-pass'
  | 'target-packed-readback'
  | 'total';

const PROFILE_METRICS: ProfileMetric[] = [
  'lit-webgl-render',
  'lit-readback',
  'unlit-material-color-render',
  'color-readback',
  'glyph-color-string-loop',
  'dom-innerhtml-commit',
  'target-lit-render',
  'target-lit-output-pass',
  'target-unlit-material-color-render',
  'target-color-output-pass',
  'target-lit-readback',
  'target-pack-pass',
  'target-packed-readback',
  'total',
];
const PROFILE_ENABLED = new URLSearchParams(window.location.search).get('profile') === '1';
const PROFILE_MAX_SAMPLES = 240;

export class GlyphEffect {
  private renderer: THREE.WebGLRenderer;
  private characters: string[];
  private color: boolean;
  private colorBrightness: number;
  private colorSaturation: number;
  private resolution: number;
  private luminanceCurve: LuminancePoint[];
  private curveLut: Uint8Array;
  private colorCache: Map<number, number[]>;
  private unlitMaterials: WeakMap<THREE.Material, THREE.MeshBasicMaterial>;
  private ownedUnlitMaterials: Set<THREE.MeshBasicMaterial>;
  public domElement: HTMLDivElement;
  private output: HTMLPreElement;
  private sampleCanvas: HTMLCanvasElement;
  private sampleContext: CanvasRenderingContext2D;
  private colorCanvas: HTMLCanvasElement;
  private colorContext: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private sampleWidth = 1;
  private sampleHeight = 1;
  private horizontalPitch = 1;
  private samplingBackend: 'canvas' | 'target';
  private targetLinear: THREE.WebGLRenderTarget | null = null;
  private targetLitDisplay: THREE.WebGLRenderTarget | null = null;
  private targetColorDisplay: THREE.WebGLRenderTarget | null = null;
  private targetPack: THREE.WebGLRenderTarget | null = null;
  private targetOutputPass: OutputPass | null = null;
  private targetPackMaterial: THREE.RawShaderMaterial | null = null;
  private targetPackQuad: FullScreenQuad | null = null;
  private targetLitPixels = new Uint8Array(0);
  private targetPackedPixels = new Uint8Array(0);
  private targetSwapRow = new Uint8Array(0);
  private readonly profileEnabled = PROFILE_ENABLED;
  private profileElement: HTMLElement | null = null;
  private profileSamples: Record<ProfileMetric, number[]> | null = null;
  private profileOccupiedGlyphs: number[] | null = null;

  constructor(renderer: THREE.WebGLRenderer, characters: string, options: GlyphEffectOptions = {}) {
    this.renderer = renderer;
    this.characters = Array.from(characters);
    this.color = options.color ?? false;
    this.samplingBackend = options.samplingBackend ?? 'canvas';
    this.colorBrightness = options.colorBrightness ?? 50;
    this.colorSaturation = options.colorSaturation ?? 0;
    this.resolution = options.resolution ?? 0.15;
    this.luminanceCurve = options.luminanceCurve ?? [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    this.curveLut = new Uint8Array(256);
    this.colorCache = new Map();
    this.unlitMaterials = new WeakMap();
    this.ownedUnlitMaterials = new Set();
    this.buildCurveLut();

    this.domElement = document.createElement('div');
    this.output = document.createElement('pre');
    this.sampleCanvas = document.createElement('canvas');
    this.sampleContext = this.sampleCanvas.getContext('2d') as CanvasRenderingContext2D;
    this.colorCanvas = document.createElement('canvas');
    this.colorContext = this.colorCanvas.getContext('2d') as CanvasRenderingContext2D;
    this.domElement.append(this.output);
    if (this.profileEnabled) {
      this.profileElement = document.querySelector('#ascii-profile');
      this.profileSamples = Object.fromEntries(PROFILE_METRICS.map((metric) => [metric, []])) as unknown as Record<ProfileMetric, number[]>;
      this.profileOccupiedGlyphs = [];
      this.publishProfile();
    }
  }

  resetProfile(): void {
    if (!this.profileSamples) return;
    PROFILE_METRICS.forEach((metric) => {
      this.profileSamples?.[metric].splice(0);
    });
    this.profileOccupiedGlyphs?.splice(0);
    this.publishProfile();
  }

  private recordProfile(metric: ProfileMetric, duration: number): void {
    const samples = this.profileSamples?.[metric];
    if (!samples) return;
    if (samples.length >= PROFILE_MAX_SAMPLES) samples.shift();
    samples.push(duration);
  }

  private publishProfile(): void {
    const element = this.profileElement;
    const samples = this.profileSamples;
    if (!element || !samples) return;
    const sampleCount = samples.total.length;
    element.dataset.profileEnabled = 'true';
    element.dataset.profileBackend = this.samplingBackend;
    element.dataset.profileReady = String(sampleCount > 0);
    element.dataset.profileSampleCount = String(sampleCount);
    element.dataset.profileSampleWidth = String(this.sampleWidth);
    element.dataset.profileHorizontalPitch = this.horizontalPitch.toFixed(3);
    const occupied = this.profileOccupiedGlyphs ?? [];
    element.dataset.profileOccupiedSamples = occupied.join(',');
    PROFILE_METRICS.forEach((metric) => {
      const values = samples[metric];
      const sorted = [...values].sort((a, b) => a - b);
      const mean = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
      const p95 = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : 0;
      element.setAttribute(`data-profile-${metric}-mean`, mean.toFixed(3));
      element.setAttribute(`data-profile-${metric}-p95`, p95.toFixed(3));
    });
  }

  private ensureTargetResources(): void {
    if (this.samplingBackend !== 'target') return;
    const samples = Math.min(4, this.renderer.capabilities.maxSamples);
    const sourceWidth = this.sampleWidth * 2;
    const sourceHeight = this.sampleHeight * 2;
    if (!this.targetLinear) {
      this.targetLinear = new THREE.WebGLRenderTarget(sourceWidth, sourceHeight, {
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType,
        colorSpace: THREE.LinearSRGBColorSpace,
        depthBuffer: true,
        stencilBuffer: false,
        samples,
      });
      this.targetLitDisplay = new THREE.WebGLRenderTarget(this.sampleWidth, this.sampleHeight, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        colorSpace: THREE.NoColorSpace,
        depthBuffer: false,
        stencilBuffer: false,
      });
      this.targetColorDisplay = new THREE.WebGLRenderTarget(this.sampleWidth, this.sampleHeight, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        colorSpace: THREE.NoColorSpace,
        depthBuffer: false,
        stencilBuffer: false,
      });
      this.targetPack = new THREE.WebGLRenderTarget(this.sampleWidth, this.sampleHeight, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        colorSpace: THREE.NoColorSpace,
        depthBuffer: false,
        stencilBuffer: false,
      });
      this.targetOutputPass = new OutputPass();
      this.targetPackMaterial = new THREE.RawShaderMaterial({
        uniforms: {
          litTexture: { value: null },
          colorTexture: { value: null },
        },
        vertexShader: `
          precision highp float;
          attribute vec3 position;
          attribute vec2 uv;
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
          }
        `,
        fragmentShader: `
          precision highp float;
          uniform sampler2D litTexture;
          uniform sampler2D colorTexture;
          varying vec2 vUv;
          void main() {
            vec3 lit = texture2D(litTexture, vUv).rgb;
            vec3 color = texture2D(colorTexture, vUv).rgb;
            float luminance = dot(lit, vec3(0.3, 0.59, 0.11));
            float quantized = floor(luminance * 255.0 + 0.5) / 255.0;
            gl_FragColor = vec4(color, quantized);
          }
        `,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      this.targetPackQuad = new FullScreenQuad(this.targetPackMaterial);
    } else {
      this.targetLinear.setSize(sourceWidth, sourceHeight);
      this.targetLitDisplay?.setSize(this.sampleWidth, this.sampleHeight);
      this.targetColorDisplay?.setSize(this.sampleWidth, this.sampleHeight);
      this.targetPack?.setSize(this.sampleWidth, this.sampleHeight);
    }
    const pixelLength = this.sampleWidth * this.sampleHeight * 4;
    if (this.targetLitPixels.length !== pixelLength) this.targetLitPixels = new Uint8Array(pixelLength);
    if (this.targetPackedPixels.length !== pixelLength) this.targetPackedPixels = new Uint8Array(pixelLength);
    const rowBytes = this.sampleWidth * 4;
    if (this.targetSwapRow.length !== rowBytes) this.targetSwapRow = new Uint8Array(rowBytes);
  }

  private readTargetPixels(target: THREE.WebGLRenderTarget, buffer: Uint8Array): Uint8Array {
    this.renderer.readRenderTargetPixels(target, 0, 0, this.sampleWidth, this.sampleHeight, buffer);
    const rowBytes = this.sampleWidth * 4;
    for (let row = 0; row < Math.floor(this.sampleHeight / 2); row += 1) {
      const top = row * rowBytes;
      const bottom = (this.sampleHeight - row - 1) * rowBytes;
      this.targetSwapRow.set(buffer.subarray(top, top + rowBytes));
      buffer.copyWithin(top, bottom, bottom + rowBytes);
      buffer.set(this.targetSwapRow, bottom);
    }
    return buffer;
  }

  private captureRendererState(): {
    target: THREE.WebGLRenderTarget | null;
    viewport: THREE.Vector4;
    scissor: THREE.Vector4;
    scissorTest: boolean;
    autoClear: boolean;
    toneMapping: THREE.ToneMapping;
    outputColorSpace: string;
    toneMappingExposure: number;
    clearColor: THREE.Color;
    clearAlpha: number;
  } {
    return {
      target: this.renderer.getRenderTarget(),
      viewport: this.renderer.getViewport(new THREE.Vector4()),
      scissor: this.renderer.getScissor(new THREE.Vector4()),
      scissorTest: this.renderer.getScissorTest(),
      autoClear: this.renderer.autoClear,
      toneMapping: this.renderer.toneMapping,
      outputColorSpace: this.renderer.outputColorSpace,
      toneMappingExposure: this.renderer.toneMappingExposure,
      clearColor: this.renderer.getClearColor(new THREE.Color()),
      clearAlpha: this.renderer.getClearAlpha(),
    };
  }

  private restoreRendererState(state: ReturnType<GlyphEffect['captureRendererState']>): void {
    this.renderer.setRenderTarget(state.target);
    this.renderer.setViewport(state.viewport);
    this.renderer.setScissor(state.scissor);
    this.renderer.setScissorTest(state.scissorTest);
    this.renderer.autoClear = state.autoClear;
    this.renderer.toneMapping = state.toneMapping;
    this.renderer.outputColorSpace = state.outputColorSpace;
    this.renderer.toneMappingExposure = state.toneMappingExposure;
    this.renderer.setClearColor(state.clearColor, state.clearAlpha);
  }

  getUnlitMaterial(source: THREE.Material & Record<string, any>): THREE.MeshBasicMaterial {
    let material = this.unlitMaterials.get(source);
    if (material) return material;

    material = new THREE.MeshBasicMaterial({
      alphaMap: source.alphaMap ?? null,
      alphaTest: source.alphaTest ?? 0,
      color: source.color?.clone() ?? new THREE.Color(0xffffff),
      depthTest: source.depthTest,
      depthWrite: source.depthWrite,
      map: source.map ?? null,
      opacity: source.opacity,
      side: source.side,
      transparent: source.transparent,
      vertexColors: source.vertexColors,
    });
    material.name = `${source.name || source.type} · ASCII UNLIT`;
    material.toneMapped = false;
    this.unlitMaterials.set(source, material);
    this.ownedUnlitMaterials.add(material);
    return material;
  }

  renderUnlitColor(scene: THREE.Scene, camera: THREE.Camera): void {
    const swaps: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = [];
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || !object.material) return;
      swaps.push([object, object.material]);
      object.material = Array.isArray(object.material)
        ? object.material.map((material) => this.getUnlitMaterial(material as THREE.Material & Record<string, any>))
        : this.getUnlitMaterial(object.material as THREE.Material & Record<string, any>);
    });

    try {
      this.renderer.render(scene, camera);
    } finally {
      swaps.forEach(([object, material]) => {
        object.material = material;
      });
    }
  }

  dispose() {
    this.ownedUnlitMaterials.forEach((material) => material.dispose());
    this.ownedUnlitMaterials.clear();
    this.targetLinear?.dispose();
    this.targetLitDisplay?.dispose();
    this.targetColorDisplay?.dispose();
    this.targetPack?.dispose();
    this.targetOutputPass?.dispose();
    this.targetPackQuad?.dispose();
    this.targetPackMaterial?.dispose();
    this.targetLinear = null;
    this.targetLitDisplay = null;
    this.targetColorDisplay = null;
    this.targetPack = null;
    this.targetOutputPass = null;
    this.targetPackQuad = null;
    this.targetPackMaterial = null;
  }

  setLuminanceCurve(points: LuminancePoint[]): void {
    this.luminanceCurve = points
      .map((point: LuminancePoint) => ({ x: Math.min(1, Math.max(0, point.x)), y: Math.min(1, Math.max(0, point.y)) }))
      .sort((a: LuminancePoint, b: LuminancePoint) => a.x - b.x);
    this.buildCurveLut();
  }

  setColorBrightness(value: number): void {
    this.colorBrightness = Math.min(100, Math.max(0, Number(value) || 0));
    this.colorCache.clear();
  }

  setColorSaturation(value: number): void {
    this.colorSaturation = Math.min(100, Math.max(-100, Number(value) || 0));
    this.colorCache.clear();
  }

  adjustBaseColor(red: number, green: number, blue: number): number[] {
    const key = (red << 16) | (green << 8) | blue;
    const cached = this.colorCache.get(key);
    if (cached) return cached;

    const r = red / 255;
    const g = green / 255;
    const b = blue / 255;
    const sourceValue = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = sourceValue - min;
    const sourceSaturation = sourceValue === 0 ? 0 : delta / sourceValue;
    let hue = 0;

    if (delta > 0) {
      if (sourceValue === r) hue = ((g - b) / delta) % 6;
      else if (sourceValue === g) hue = (b - r) / delta + 2;
      else hue = (r - g) / delta + 4;
      hue /= 6;
      if (hue < 0) hue += 1;
    }

    // The brightness midpoint preserves the authored Value. The lower half
    // approaches zero; the upper half approaches the display maximum.
    const position = this.colorBrightness / 100;
    const targetValue = position <= 0.5
      ? sourceValue * (position / 0.5)
      : sourceValue + (1 - sourceValue) * ((position - 0.5) / 0.5);

    const saturationPosition = this.colorSaturation / 100;
    const targetSaturation = saturationPosition <= 0
      ? sourceSaturation * (1 + saturationPosition)
      : sourceSaturation === 0
        ? 0
        : sourceSaturation + (1 - sourceSaturation) * saturationPosition;

    const sector = hue * 6;
    const chroma = targetValue * targetSaturation;
    const secondary = chroma * (1 - Math.abs((sector % 2) - 1));
    const match = targetValue - chroma;
    let channels;

    if (sector < 1) channels = [chroma, secondary, 0];
    else if (sector < 2) channels = [secondary, chroma, 0];
    else if (sector < 3) channels = [0, chroma, secondary];
    else if (sector < 4) channels = [0, secondary, chroma];
    else if (sector < 5) channels = [secondary, 0, chroma];
    else channels = [chroma, 0, secondary];

    const adjusted = channels.map((channel) => Math.round((channel + match) * 255));

    if (this.colorCache.size > 131072) this.colorCache.clear();
    this.colorCache.set(key, adjusted);
    return adjusted;
  }

  buildCurveLut() {
    const points = this.luminanceCurve;
    const secants = points.slice(0, -1).map((point, index) => {
      const next = points[index + 1];
      return (next.y - point.y) / Math.max(0.000001, next.x - point.x);
    });
    const slopes = [secants[0] ?? 0];
    for (let index = 1; index < points.length - 1; index += 1) {
      const previous = secants[index - 1];
      const next = secants[index];
      if (previous * next <= 0) {
        slopes.push(0);
        continue;
      }
      const hPrevious = points[index].x - points[index - 1].x;
      const hNext = points[index + 1].x - points[index].x;
      const weightPrevious = 2 * hNext + hPrevious;
      const weightNext = hNext + 2 * hPrevious;
      slopes.push((weightPrevious + weightNext) / (weightPrevious / previous + weightNext / next));
    }
    slopes.push(secants[secants.length - 1] ?? 0);

    for (let index = 0; index < this.curveLut.length; index += 1) {
      const x = index / (this.curveLut.length - 1);
      let segment = 0;
      while (segment < points.length - 2 && x > points[segment + 1].x) segment += 1;
      const p1 = points[segment];
      const p2 = points[Math.min(points.length - 1, segment + 1)] ?? p1;
      const span = Math.max(0.000001, p2.x - p1.x);
      const t = Math.min(1, Math.max(0, (x - p1.x) / span));
      const t2 = t * t;
      const t3 = t2 * t;
      // Monotone cubic Hermite (PCHIP) interpolation gives a smooth,
      // Bézier-style transfer without overshooting the user's points.
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      const segmentIndex = segment;
      const value = h00 * p1.y
        + h10 * span * slopes[segmentIndex]
        + h01 * p2.y
        + h11 * span * slopes[segmentIndex + 1];
      this.curveLut[index] = Math.round(Math.min(1, Math.max(0, value)) * 255);
    }
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const characterSize = 2 / this.resolution;
    this.sampleContext.font = `${characterSize}px "Courier New", monospace`;
    this.horizontalPitch = Math.max(1, this.sampleContext.measureText('M').width - 1);
    this.sampleWidth = Math.max(1, Math.ceil(width / this.horizontalPitch));
    this.sampleHeight = Math.max(1, Math.floor(height * this.resolution));
    this.sampleCanvas.width = this.sampleWidth;
    this.sampleCanvas.height = this.sampleHeight;
    this.colorCanvas.width = this.sampleWidth;
    this.colorCanvas.height = this.sampleHeight;
    this.ensureTargetResources();
    this.renderer.setSize(width, height);

    Object.assign(this.output.style, {
      width: `${width}px`,
      height: `${height}px`,
      margin: '0',
      padding: '0',
      overflow: 'hidden',
      whiteSpace: 'pre',
      fontFamily: '"Courier New", monospace',
      fontSize: `${characterSize}px`,
      lineHeight: `${characterSize}px`,
      letterSpacing: '-1px',
      textAlign: 'left',
      textDecoration: 'none',
    });
  }

  private emitGlyphs(
    litPixels: ArrayLike<number>,
    colorPixels: ArrayLike<number>,
    packedLuminance = false,
  ): void {
    const lastCharacter = this.characters.length - 1;
    const lines = [];
    let occupiedGlyphs = 0;
    const glyphLoopStart = this.profileEnabled ? performance.now() : 0;
    for (let y = 0; y < this.sampleHeight; y += 2) {
      let line = '';
      for (let x = 0; x < this.sampleWidth; x += 1) {
        const offset = (y * this.sampleWidth + x) * 4;
        const litRed = litPixels[offset];
        const litGreen = litPixels[offset + 1];
        const litBlue = litPixels[offset + 2];
        const luminance = packedLuminance
          ? litPixels[offset + 3] / 255
          : (0.3 * litRed + 0.59 * litGreen + 0.11 * litBlue) / 255;
        const glyphLuminance = this.curveLut[Math.round(luminance * 255)] / 255;
        const character = this.characters[Math.floor(glyphLuminance * lastCharacter)] ?? ' ';
        if (this.profileEnabled && character !== ' ') occupiedGlyphs += 1;
        const escapedCharacter = character === ' '
          ? '&nbsp;'
          : character === '&'
            ? '&amp;'
            : character === '<'
              ? '&lt;'
                : character === '>'
                  ? '&gt;'
                  : character;

        if (this.color && character !== ' ') {
          const [red, green, blue] = this.adjustBaseColor(
            colorPixels[offset],
            colorPixels[offset + 1],
            colorPixels[offset + 2],
          );
          line += `<span style="color:rgb(${red},${green},${blue})">${escapedCharacter}</span>`;
        } else {
          line += escapedCharacter;
        }
      }
      lines.push(line);
    }
    if (this.profileEnabled) {
      this.recordProfile('glyph-color-string-loop', performance.now() - glyphLoopStart);
      const occupiedSamples = this.profileOccupiedGlyphs;
      if (occupiedSamples) {
        if (occupiedSamples.length >= PROFILE_MAX_SAMPLES) occupiedSamples.shift();
        occupiedSamples.push(occupiedGlyphs);
      }
    }

    const domCommitStart = this.profileEnabled ? performance.now() : 0;
    this.output.innerHTML = lines.join('\n');
    if (this.profileEnabled) this.recordProfile('dom-innerhtml-commit', performance.now() - domCommitStart);
  }

  private renderTarget(scene: THREE.Scene, camera: THREE.Camera): void {
    this.ensureTargetResources();
    if (
      !this.targetLinear
      || !this.targetLitDisplay
      || !this.targetColorDisplay
      || !this.targetPack
      || !this.targetOutputPass
      || !this.targetPackMaterial
      || !this.targetPackQuad
    ) return;

    const totalStart = this.profileEnabled ? performance.now() : 0;
    const state = this.captureRendererState();
    const sourceWidth = this.sampleWidth * 2;
    const sourceHeight = this.sampleHeight * 2;
    try {
      this.renderer.autoClear = true;
      this.renderer.setViewport(0, 0, sourceWidth, sourceHeight);
      this.renderer.setScissor(0, 0, sourceWidth, sourceHeight);
      this.renderer.setScissorTest(false);
      this.renderer.setRenderTarget(this.targetLinear);
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

      const litRenderStart = this.profileEnabled ? performance.now() : 0;
      this.renderer.render(scene, camera);
      if (this.profileEnabled) this.recordProfile('target-lit-render', performance.now() - litRenderStart);

      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      const litOutputStart = this.profileEnabled ? performance.now() : 0;
      this.targetOutputPass.render(this.renderer, this.targetLitDisplay, this.targetLinear, 0, false);
      if (this.profileEnabled) this.recordProfile('target-lit-output-pass', performance.now() - litOutputStart);

      if (this.color) {
        this.renderer.setRenderTarget(this.targetLinear);
        this.renderer.setViewport(0, 0, sourceWidth, sourceHeight);
        this.renderer.setScissor(0, 0, sourceWidth, sourceHeight);
        this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
        const unlitRenderStart = this.profileEnabled ? performance.now() : 0;
        this.renderUnlitColor(scene, camera);
        if (this.profileEnabled) this.recordProfile('target-unlit-material-color-render', performance.now() - unlitRenderStart);

        this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        const colorOutputStart = this.profileEnabled ? performance.now() : 0;
        this.targetOutputPass.render(this.renderer, this.targetColorDisplay, this.targetLinear, 0, false);
        if (this.profileEnabled) this.recordProfile('target-color-output-pass', performance.now() - colorOutputStart);

        this.targetPackMaterial.uniforms.litTexture.value = this.targetLitDisplay.texture;
        this.targetPackMaterial.uniforms.colorTexture.value = this.targetColorDisplay.texture;
        this.renderer.setRenderTarget(this.targetPack);
        this.renderer.setViewport(0, 0, this.sampleWidth, this.sampleHeight);
        this.renderer.setScissor(0, 0, this.sampleWidth, this.sampleHeight);
        this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
        const packStart = this.profileEnabled ? performance.now() : 0;
        this.targetPackQuad.render(this.renderer);
        if (this.profileEnabled) this.recordProfile('target-pack-pass', performance.now() - packStart);

        const packedReadbackStart = this.profileEnabled ? performance.now() : 0;
        this.readTargetPixels(this.targetPack, this.targetPackedPixels);
        if (this.profileEnabled) this.recordProfile('target-packed-readback', performance.now() - packedReadbackStart);
        this.emitGlyphs(this.targetPackedPixels, this.targetPackedPixels, true);
      } else {
        const litReadbackStart = this.profileEnabled ? performance.now() : 0;
        this.readTargetPixels(this.targetLitDisplay, this.targetLitPixels);
        if (this.profileEnabled) this.recordProfile('target-lit-readback', performance.now() - litReadbackStart);
        this.emitGlyphs(this.targetLitPixels, this.targetLitPixels);
      }
      if (this.profileEnabled) this.recordProfile('total', performance.now() - totalStart);
    } finally {
      this.restoreRendererState(state);
      if (this.profileEnabled) this.publishProfile();
    }
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.samplingBackend === 'target') {
      this.renderTarget(scene, camera);
      return;
    }
    const totalStart = this.profileEnabled ? performance.now() : 0;
    const litRenderStart = this.profileEnabled ? performance.now() : 0;
    this.renderer.render(scene, camera);
    if (this.profileEnabled) this.recordProfile('lit-webgl-render', performance.now() - litRenderStart);

    const litReadbackStart = this.profileEnabled ? performance.now() : 0;
    this.sampleContext.clearRect(0, 0, this.sampleWidth, this.sampleHeight);
    this.sampleContext.drawImage(this.renderer.domElement, 0, 0, this.sampleWidth, this.sampleHeight);
    const pixels = this.sampleContext.getImageData(0, 0, this.sampleWidth, this.sampleHeight).data;
    if (this.profileEnabled) this.recordProfile('lit-readback', performance.now() - litReadbackStart);
    let colorPixels = pixels;
    if (this.color) {
      const unlitRenderStart = this.profileEnabled ? performance.now() : 0;
      this.renderUnlitColor(scene, camera);
      if (this.profileEnabled) this.recordProfile('unlit-material-color-render', performance.now() - unlitRenderStart);

      const colorReadbackStart = this.profileEnabled ? performance.now() : 0;
      this.colorContext.clearRect(0, 0, this.sampleWidth, this.sampleHeight);
      this.colorContext.drawImage(this.renderer.domElement, 0, 0, this.sampleWidth, this.sampleHeight);
      colorPixels = this.colorContext.getImageData(0, 0, this.sampleWidth, this.sampleHeight).data;
      if (this.profileEnabled) this.recordProfile('color-readback', performance.now() - colorReadbackStart);
    }
    this.emitGlyphs(pixels, colorPixels);
    if (this.profileEnabled) {
      this.recordProfile('total', performance.now() - totalStart);
      this.publishProfile();
    }
  }
}
