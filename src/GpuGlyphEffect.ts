import * as THREE from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import type { LuminancePoint } from './asciiPreset';

export interface GpuGlyphEffectOptions {
  color?: boolean;
  colorBrightness?: number;
  colorSaturation?: number;
  resolution?: number;
  luminanceCurve?: LuminancePoint[];
}

type GpuProfileMetric = 'lit-render' | 'unlit-render' | 'glyph-pass' | 'total';
const GPU_PROFILE_METRICS: GpuProfileMetric[] = ['lit-render', 'unlit-render', 'glyph-pass', 'total'];
const GPU_PROFILE_MAX_SAMPLES = 240;

export class GpuGlyphEffect {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly characters: string[];
  private readonly color: boolean;
  private colorBrightness: number;
  private colorSaturation: number;
  private readonly resolution: number;
  private luminanceCurve: LuminancePoint[];
  private curveLut = new Uint8Array(256);
  private curveTexture: THREE.DataTexture;
  private atlasTexture: THREE.CanvasTexture;
  private atlasCanvas: HTMLCanvasElement;
  private atlasContext: CanvasRenderingContext2D;
  private atlasColumns = 16;
  private atlasRows = 1;
  private atlasCellWidth = 8;
  private atlasCellHeight = 16;
  private atlasGlyphSize = 0;
  private sampleWidth = 1;
  private sampleHeight = 1;
  private gridRows = 1;
  private logicalHorizontalPitch = 1;
  private horizontalPitch = 1;
  private pixelRatio: number;
  private width = 1;
  private height = 1;
  private sourceTarget: THREE.WebGLRenderTarget;
  private litDisplayTarget: THREE.WebGLRenderTarget;
  private colorDisplayTarget: THREE.WebGLRenderTarget;
  private litOutputPass: OutputPass;
  private colorOutputPass: OutputPass;
  private material: THREE.RawShaderMaterial;
  private quad: FullScreenQuad;
  private unlitMaterials = new WeakMap<THREE.Material, THREE.MeshBasicMaterial>();
  private ownedUnlitMaterials = new Set<THREE.MeshBasicMaterial>();
  private profileEnabled = new URLSearchParams(window.location.search).get('profile') === '1';
  private profileElement = document.querySelector('#ascii-profile') as HTMLElement | null;
  private profileSamples: Record<GpuProfileMetric, number[]> = {
    'lit-render': [],
    'unlit-render': [],
    'glyph-pass': [],
    total: [],
  };

  constructor(renderer: THREE.WebGLRenderer, characters: string, options: GpuGlyphEffectOptions = {}) {
    this.renderer = renderer;
    this.pixelRatio = renderer.getPixelRatio();
    this.characters = Array.from(characters);
    this.color = options.color ?? false;
    this.colorBrightness = options.colorBrightness ?? 50;
    this.colorSaturation = options.colorSaturation ?? 0;
    this.resolution = options.resolution ?? 0.15;
    this.luminanceCurve = options.luminanceCurve ?? [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    this.buildCurveLut();

    this.atlasCanvas = document.createElement('canvas');
    this.atlasContext = this.atlasCanvas.getContext('2d') as CanvasRenderingContext2D;
    this.atlasTexture = new THREE.CanvasTexture(this.atlasCanvas);
    this.atlasTexture.colorSpace = THREE.NoColorSpace;
    // Keep the shader's top-to-bottom row convention. Linear filtering and
    // mipmaps are disabled so samples cannot borrow alpha from neighboring
    // glyph cells (especially the blank space cell).
    this.atlasTexture.flipY = false;
    this.atlasTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.atlasTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.atlasTexture.minFilter = THREE.LinearFilter;
    this.atlasTexture.magFilter = THREE.LinearFilter;
    this.atlasTexture.generateMipmaps = false;
    this.curveTexture = new THREE.DataTexture(this.curveLut, 256, 1, THREE.RedFormat, THREE.UnsignedByteType);
    this.curveTexture.colorSpace = THREE.NoColorSpace;
    this.curveTexture.minFilter = THREE.NearestFilter;
    this.curveTexture.magFilter = THREE.NearestFilter;
    this.curveTexture.needsUpdate = true;

    this.sourceTarget = new THREE.WebGLRenderTarget(1, 1, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
    });
    this.litDisplayTarget = this.createDisplayTarget();
    this.colorDisplayTarget = this.createDisplayTarget();
    this.litOutputPass = new OutputPass();
    this.colorOutputPass = new OutputPass();
    this.material = this.createMaterial();
    this.quad = new FullScreenQuad(this.material);
    this.rebuildAtlas(12);
    this.publishProfile();
  }

  private createDisplayTarget(): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(1, 1, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
    });
  }

  private createMaterial(): THREE.RawShaderMaterial {
    return new THREE.RawShaderMaterial({
      uniforms: {
        litTexture: { value: this.litDisplayTarget.texture },
        colorTexture: { value: this.colorDisplayTarget.texture },
        atlasTexture: { value: this.atlasTexture },
        curveTexture: { value: this.curveTexture },
        viewport: { value: new THREE.Vector2(1, 1) },
        sampleSize: { value: new THREE.Vector2(1, 1) },
        gridRows: { value: 1 },
        cellPitch: { value: 1 },
        glyphSize: { value: 12 },
        atlasGrid: { value: new THREE.Vector2(16, 1) },
        atlasTextureSize: { value: new THREE.Vector2(1, 1) },
        characterCount: { value: this.characters.length },
        colorEnabled: { value: this.color },
        brightness: { value: this.colorBrightness / 100 },
        saturation: { value: this.colorSaturation / 100 },
      },
      vertexShader: `
        precision highp float;
        attribute vec3 position;
        attribute vec2 uv;
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: `
        precision highp float;
        uniform sampler2D litTexture;
        uniform sampler2D colorTexture;
        uniform sampler2D atlasTexture;
        uniform sampler2D curveTexture;
        uniform vec2 viewport;
        uniform vec2 sampleSize;
        uniform float gridRows;
        uniform float cellPitch;
        uniform float glyphSize;
        uniform vec2 atlasGrid;
        uniform vec2 atlasTextureSize;
        uniform float characterCount;
        uniform bool colorEnabled;
        uniform float brightness;
        uniform float saturation;
        varying vec2 vUv;

        vec3 hsvToRgb(vec3 hsv) {
          vec3 rgb = clamp(abs(mod(hsv.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
          return hsv.z * mix(vec3(1.0), rgb, hsv.y);
        }

        vec3 adjustColor(vec3 source) {
          float value = max(source.r, max(source.g, source.b));
          float minimum = min(source.r, min(source.g, source.b));
          float delta = value - minimum;
          float hue = 0.0;
          if (delta > 0.0) {
            if (value == source.r) hue = mod((source.g - source.b) / delta, 6.0);
            else if (value == source.g) hue = (source.b - source.r) / delta + 2.0;
            else hue = (source.r - source.g) / delta + 4.0;
            hue = hue / 6.0;
            if (hue < 0.0) hue += 1.0;
          }
          float sourceSaturation = value == 0.0 ? 0.0 : delta / value;
          float targetValue = brightness <= 0.5
            ? value * (brightness / 0.5)
            : value + (1.0 - value) * ((brightness - 0.5) / 0.5);
          float targetSaturation = saturation <= 0.0
            ? sourceSaturation * (1.0 + saturation)
            : (sourceSaturation == 0.0 ? 0.0 : sourceSaturation + (1.0 - sourceSaturation) * saturation);
          return hsvToRgb(vec3(hue, targetSaturation, targetValue));
        }

        void main() {
          vec2 screen = vec2(gl_FragCoord.x, viewport.y - gl_FragCoord.y);
          float column = floor(screen.x / cellPitch);
          float row = floor(screen.y / glyphSize);
          if (column < 0.0 || column >= sampleSize.x || row < 0.0 || row >= gridRows) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
          vec2 normalized = screen / viewport;
          vec2 sourceUv = vec2((column + 0.5) / sampleSize.x, (sampleSize.y - row * 2.0 - 1.0) / sampleSize.y);
          vec3 lit = texture2D(litTexture, sourceUv).rgb;
          float luminance = dot(lit, vec3(0.3, 0.59, 0.11));
          float curved = texture2D(curveTexture, vec2(luminance, 0.5)).r;
          float index = floor(curved * (characterCount - 1.0));
          vec2 atlasCell = vec2(mod(index, atlasGrid.x), floor(index / atlasGrid.x));
          vec2 local = vec2(fract(screen.x / cellPitch), fract(screen.y / glyphSize));
          vec2 atlasMin = atlasCell / atlasGrid;
          vec2 atlasMax = (atlasCell + 1.0) / atlasGrid;
          vec2 halfTexel = 0.5 / atlasTextureSize;
          vec2 atlasUv = clamp((atlasCell + local) / atlasGrid, atlasMin + halfTexel, atlasMax - halfTexel);
          float alpha = texture2D(atlasTexture, atlasUv).a;
          float coverage = pow(max(alpha, 0.0), 0.8);
          vec3 outputColor = colorEnabled ? adjustColor(texture2D(colorTexture, sourceUv).rgb) : vec3(238.0 / 255.0, 233.0 / 255.0, 220.0 / 255.0);
          // The GPU canvas is composited directly over the page. Keep its
          // background opaque black while retaining glyph coverage in RGB.
          gl_FragColor = vec4(outputColor * coverage, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
  }

  private rebuildAtlas(glyphSize: number): void {
    this.atlasGlyphSize = glyphSize;
    const rasterGlyphSize = Math.max(2, glyphSize * this.pixelRatio);
    const gutter = 1;
    this.atlasCellWidth = Math.max(4, Math.ceil(rasterGlyphSize / 2) + gutter * 2);
    this.atlasCellHeight = Math.max(4, Math.ceil(rasterGlyphSize) + gutter * 2);
    this.atlasColumns = Math.min(16, Math.max(1, this.characters.length));
    this.atlasRows = Math.ceil(this.characters.length / this.atlasColumns);
    this.atlasCanvas.width = this.atlasCellWidth * this.atlasColumns;
    this.atlasCanvas.height = this.atlasCellHeight * this.atlasRows;
    this.atlasContext.clearRect(0, 0, this.atlasCanvas.width, this.atlasCanvas.height);
    this.atlasContext.fillStyle = '#fff';
    this.atlasContext.font = `${rasterGlyphSize}px "Courier New", monospace`;
    this.atlasContext.textBaseline = 'top';
    this.logicalHorizontalPitch = Math.max(1, this.atlasContext.measureText('M').width / Math.max(1, this.pixelRatio) - 1);
    this.horizontalPitch = this.logicalHorizontalPitch * this.pixelRatio;
    this.characters.forEach((character, index) => {
      if (character === ' ') return;
      const x = (index % this.atlasColumns) * this.atlasCellWidth + gutter;
      const y = Math.floor(index / this.atlasColumns) * this.atlasCellHeight + gutter;
      this.atlasContext.fillText(character, x, y);
    });
    this.atlasTexture.needsUpdate = true;
    if (this.material?.uniforms.atlasGrid) this.material.uniforms.atlasGrid.value.set(this.atlasColumns, this.atlasRows);
    if (this.material?.uniforms.atlasTextureSize) this.material.uniforms.atlasTextureSize.value.set(this.atlasCanvas.width, this.atlasCanvas.height);
    if (this.material?.uniforms.cellPitch) this.material.uniforms.cellPitch.value = this.horizontalPitch;
  }

  private buildCurveLut(): void {
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
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      const value = h00 * p1.y
        + h10 * span * slopes[segment]
        + h01 * p2.y
        + h11 * span * slopes[segment + 1];
      this.curveLut[index] = Math.round(Math.min(1, Math.max(0, value)) * 255);
    }
    if (this.curveTexture) this.curveTexture.needsUpdate = true;
  }

  private recordProfile(metric: GpuProfileMetric, duration: number): void {
    if (!this.profileEnabled) return;
    const samples = this.profileSamples[metric];
    if (samples.length >= GPU_PROFILE_MAX_SAMPLES) samples.shift();
    samples.push(duration);
  }

  private publishProfile(): void {
    if (!this.profileEnabled || !this.profileElement) return;
    this.profileElement.dataset.profileEnabled = 'true';
    this.profileElement.dataset.profileBackend = 'gpu';
    this.profileElement.dataset.profileSampleCount = String(this.profileSamples.total.length);
    this.profileElement.dataset.profileOccupiedSamples = '';
    this.profileElement.dataset.profileSampleWidth = String(this.sampleWidth);
    this.profileElement.dataset.profileHorizontalPitch = (this.horizontalPitch / Math.max(1, this.pixelRatio)).toFixed(3);
    this.profileElement.dataset.profileCurveTextureVersion = String(this.curveTexture.version);
    GPU_PROFILE_METRICS.forEach((metric) => {
      const values = this.profileSamples[metric];
      const sorted = [...values].sort((a, b) => a - b);
      const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
      const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : 0;
      this.profileElement?.setAttribute(`data-profile-gpu-${metric}-mean`, mean.toFixed(3));
      this.profileElement?.setAttribute(`data-profile-gpu-${metric}-p95`, p95.toFixed(3));
    });
  }

  resetProfile(): void {
    GPU_PROFILE_METRICS.forEach((metric) => this.profileSamples[metric].splice(0));
    this.publishProfile();
  }

  getUnlitMaterial(source: THREE.Material & Record<string, any>): THREE.MeshBasicMaterial {
    const existing = this.unlitMaterials.get(source);
    if (existing) return existing;
    const material = new THREE.MeshBasicMaterial({
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
    material.toneMapped = false;
    this.unlitMaterials.set(source, material);
    this.ownedUnlitMaterials.add(material);
    return material;
  }

  private renderUnlit(scene: THREE.Scene, camera: THREE.Camera): void {
    const swaps: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = [];
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || !object.material) return;
      swaps.push([object, object.material]);
      object.material = Array.isArray(object.material)
        ? object.material.map((material) => this.getUnlitMaterial(material as THREE.Material & Record<string, any>))
        : this.getUnlitMaterial(object.material as THREE.Material & Record<string, any>);
    });
    try { this.renderer.render(scene, camera); }
    finally { swaps.forEach(([object, material]) => { object.material = material; }); }
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const nextPixelRatio = this.renderer.getPixelRatio();
    const pixelRatioChanged = nextPixelRatio !== this.pixelRatio;
    this.pixelRatio = nextPixelRatio;
    const logicalGlyphSize = 2 / this.resolution;
    if (pixelRatioChanged || this.atlasCanvas.width === 0 || this.atlasGlyphSize !== logicalGlyphSize) {
      this.rebuildAtlas(logicalGlyphSize);
    }
    this.sampleWidth = Math.max(1, Math.ceil((width * this.pixelRatio) / this.horizontalPitch));
    this.sampleHeight = Math.max(1, Math.floor(height * this.resolution));
    this.gridRows = Math.ceil(this.sampleHeight / 2);
    this.sourceTarget.setSize(this.sampleWidth, this.sampleHeight);
    this.litDisplayTarget.setSize(this.sampleWidth, this.sampleHeight);
    this.colorDisplayTarget.setSize(this.sampleWidth, this.sampleHeight);
    this.material.uniforms.viewport.value.set(width * this.pixelRatio, height * this.pixelRatio);
    this.material.uniforms.sampleSize.value.set(this.sampleWidth, this.sampleHeight);
    this.material.uniforms.gridRows.value = this.gridRows;
    this.material.uniforms.glyphSize.value = (2 / this.resolution) * this.pixelRatio;
    this.material.uniforms.cellPitch.value = this.horizontalPitch;
  }

  setLuminanceCurve(points: LuminancePoint[]): void {
    this.luminanceCurve = points.map((point) => ({ x: Math.min(1, Math.max(0, point.x)), y: Math.min(1, Math.max(0, point.y)) })).sort((a, b) => a.x - b.x);
    this.buildCurveLut();
  }

  setColorBrightness(value: number): void {
    this.colorBrightness = Math.min(100, Math.max(0, Number(value) || 0));
    this.material.uniforms.brightness.value = this.colorBrightness / 100;
  }

  setColorSaturation(value: number): void {
    this.colorSaturation = Math.min(100, Math.max(-100, Number(value) || 0));
    this.material.uniforms.saturation.value = this.colorSaturation / 100;
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const previousTarget = this.renderer.getRenderTarget();
    const previousViewport = this.renderer.getViewport(new THREE.Vector4());
    const previousScissor = this.renderer.getScissor(new THREE.Vector4());
    const previousScissorTest = this.renderer.getScissorTest();
    const previousToneMapping = this.renderer.toneMapping;
    const previousOutputColorSpace = this.renderer.outputColorSpace;
    const previousAutoClear = this.renderer.autoClear;
    const totalStart = this.profileEnabled ? performance.now() : 0;
    try {
      this.renderer.autoClear = true;
      this.renderer.setViewport(0, 0, this.sampleWidth, this.sampleHeight);
      this.renderer.setScissor(0, 0, this.sampleWidth, this.sampleHeight);
      this.renderer.setScissorTest(false);
      this.renderer.setRenderTarget(this.sourceTarget);
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      const litStart = this.profileEnabled ? performance.now() : 0;
      this.renderer.render(scene, camera);
      if (this.profileEnabled) this.recordProfile('lit-render', performance.now() - litStart);

      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.litOutputPass.render(this.renderer, this.litDisplayTarget, this.sourceTarget, 0, false);

      let colorTarget = this.litDisplayTarget;
      if (this.color) {
        this.renderer.setRenderTarget(this.sourceTarget);
        this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
        const unlitStart = this.profileEnabled ? performance.now() : 0;
        this.renderUnlit(scene, camera);
        if (this.profileEnabled) this.recordProfile('unlit-render', performance.now() - unlitStart);
        this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.colorOutputPass.render(this.renderer, this.colorDisplayTarget, this.sourceTarget, 0, false);
        colorTarget = this.colorDisplayTarget;
      }
      this.material.uniforms.litTexture.value = this.litDisplayTarget.texture;
      this.material.uniforms.colorTexture.value = colorTarget.texture;
      this.renderer.setRenderTarget(null);
      this.renderer.setViewport(0, 0, this.width, this.height);
      this.renderer.setScissor(0, 0, this.width, this.height);
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      const glyphStart = this.profileEnabled ? performance.now() : 0;
      this.quad.render(this.renderer);
      if (this.profileEnabled) this.recordProfile('glyph-pass', performance.now() - glyphStart);
      if (this.profileEnabled) this.recordProfile('total', performance.now() - totalStart);
    } finally {
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.setViewport(previousViewport);
      this.renderer.setScissor(previousScissor);
      this.renderer.setScissorTest(previousScissorTest);
      this.renderer.toneMapping = previousToneMapping;
      this.renderer.outputColorSpace = previousOutputColorSpace;
      this.renderer.autoClear = previousAutoClear;
      this.publishProfile();
    }
  }

  dispose(): void {
    this.sourceTarget.dispose();
    this.litDisplayTarget.dispose();
    this.colorDisplayTarget.dispose();
    this.litOutputPass.dispose();
    this.colorOutputPass.dispose();
    this.atlasTexture.dispose();
    this.curveTexture.dispose();
    this.quad.dispose();
    this.material.dispose();
    this.ownedUnlitMaterials.forEach((material) => material.dispose());
    this.ownedUnlitMaterials.clear();
  }
}
