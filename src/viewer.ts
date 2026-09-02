import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GlyphEffect } from './GlyphEffect';
import { GpuGlyphEffect } from './GpuGlyphEffect';
import { BASE_ROTATION_RATE, loadSavedAsciiPreset, normalizeAsciiPreset, saveAsciiPreset } from './asciiPreset';
import type { AsciiPreset, LuminancePoint } from './asciiPreset';
import { loadProtea } from './model/loadProtea';
import publishedHomePresetJson from './publishedHomePreset.json';
import './viewer.css';

const stage = document.querySelector('#viewer-stage') as HTMLElement;
const status = document.querySelector('#viewer-status') as HTMLElement;
const rotateToggle = document.querySelector('#rotate-toggle') as HTMLButtonElement;
const resetButton = document.querySelector('#reset-view') as HTMLButtonElement;
const controlPanel = document.querySelector('#control-panel') as HTMLElement;
const controlPanelDragHandle = document.querySelector('#control-panel-drag-handle') as HTMLElement;
const controlsClose = document.querySelector('#controls-close') as HTMLButtonElement;
const controlsOpen = document.querySelector('#controls-open') as HTMLButtonElement;
const meshCount = document.querySelector('#mesh-count') as HTMLElement;
const triangleCount = document.querySelector('#triangle-count') as HTMLElement;
const asciiToggle = document.querySelector('#ascii-toggle') as HTMLButtonElement;
const asciiColorToggle = document.querySelector('#ascii-color-toggle') as HTMLButtonElement;
const asciiCharsetToggle = document.querySelector('#ascii-charset-toggle') as HTMLButtonElement;
const asciiBrightness = document.querySelector('#ascii-brightness') as HTMLInputElement;
const asciiBrightnessOutput = document.querySelector('#ascii-brightness-output') as HTMLOutputElement;
const asciiSaturation = document.querySelector('#ascii-saturation') as HTMLInputElement;
const asciiSaturationOutput = document.querySelector('#ascii-saturation-output') as HTMLOutputElement;
const materialRoughness = document.querySelector('#material-roughness') as HTMLInputElement;
const materialRoughnessOutput = document.querySelector('#material-roughness-output') as HTMLOutputElement;
const rotationSpeed = document.querySelector('#rotation-speed') as HTMLInputElement;
const rotationSpeedOutput = document.querySelector('#rotation-speed-output') as HTMLOutputElement;
const defaultTilt = document.querySelector('#default-tilt') as HTMLInputElement;
const defaultTiltOutput = document.querySelector('#default-tilt-output') as HTMLOutputElement;
const asciiSize = document.querySelector('#ascii-size') as HTMLInputElement;
const asciiSizeValue = document.querySelector('#ascii-size-value') as HTMLOutputElement;
const renderModeLabel = document.querySelector('#render-mode-label') as HTMLElement;
const curveGraph = document.querySelector('#curve-graph') as SVGSVGElement;
const curvePlot = curveGraph.querySelector('.curve-graph__plot') as SVGRectElement;
const curvePath = document.querySelector('#curve-path') as SVGPathElement;
const curvePointsGroup = document.querySelector('#curve-points') as SVGGElement;
const curveSave = document.querySelector('#curve-save') as HTMLButtonElement;
const presetPublish = document.querySelector('#preset-publish') as HTMLButtonElement;
const curveReset = document.querySelector('#curve-reset') as HTMLButtonElement;
const curveValue = document.querySelector('#curve-value') as HTMLOutputElement;
const asciiFps = document.querySelector('#ascii-fps') as HTMLElement;
const asciiProfile = document.querySelector('#ascii-profile') as HTMLElement;

const ASCII_CHARACTERS = ' .,:;irsXA253hMHGS#9B&@';
const UNICODE_CHARACTERS = '  ·˙⠁⠃⠇⠏⠟⠿⡿⣿░▒▓█';
const ORIGINAL_BACKGROUND = 0x121212;
const ASCII_BACKGROUND = 0x000000;
const BASE_EXPOSURE = 1.15;
const CURVE_PLOT = { left: 22, top: 8, width: 202, height: 102 };
const MAX_CURVE_POINTS = 9;
const samplingBackend: 'canvas' = 'canvas';
const viewerQuery = new URLSearchParams(window.location.search);
const explicitRenderer = viewerQuery.get('asciiRenderer');
const legacyTargetRequested = viewerQuery.get('asciiSampler') === 'target';
const gpuRendererEnabled = explicitRenderer !== 'dom'
  && !(legacyTargetRequested && explicitRenderer === null);
const DEFAULT_CURVE: LuminancePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];
const normalizedPublishedHomePreset = normalizeAsciiPreset(publishedHomePresetJson);
if (!normalizedPublishedHomePreset) throw new Error('The published homepage preset is invalid.');
const publishedHomePreset: AsciiPreset = normalizedPublishedHomePreset;
const savedAsciiPreset = loadSavedAsciiPreset() ?? publishedHomePreset;
presetPublish.hidden = !import.meta.env.DEV;

if (savedAsciiPreset) {
  asciiBrightness.value = String(savedAsciiPreset.colorBrightness);
  asciiSaturation.value = String(savedAsciiPreset.colorSaturation);
  asciiSize.value = String(savedAsciiPreset.glyphSize);
  rotationSpeed.value = String(savedAsciiPreset.rotationSpeed);
  defaultTilt.value = String(savedAsciiPreset.defaultTilt);
  if (savedAsciiPreset.materialRoughness !== null) {
    materialRoughness.value = String(savedAsciiPreset.materialRoughness);
  }
}

let luminanceCurve: LuminancePoint[] = (savedAsciiPreset?.luminanceCurve ?? DEFAULT_CURVE).map((point: LuminancePoint) => ({ ...point }));
let activeCurvePoint: number | null = null;
let suppressCurveClick = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(ORIGINAL_BACKGROUND);

const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 10000);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = BASE_EXPOSURE;
stage.prepend(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.055;
controls.autoRotate = false;
controls.enablePan = false;

scene.add(new THREE.HemisphereLight(0xfff4eb, 0x182031, 2.4));

const keyLight = new THREE.DirectionalLight(0xfff2e6, 4.2);
keyLight.position.set(4, 7, 6);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xd7c1ff, 2.5);
fillLight.position.set(-5, 2, 3);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xff6fb7, 2.2);
rimLight.position.set(1, 3, -6);
scene.add(rimLight);

let modelRoot: THREE.Group | null = null;
let tiltRoot: THREE.Group | null = null;
let grid: THREE.GridHelper | null = null;
let homePosition = new THREE.Vector3();
let asciiEffect: GlyphEffect | null = null;
let gpuAsciiEffect: GpuGlyphEffect | null = null;
let asciiEnabled = false;
let asciiColor = savedAsciiPreset?.color ?? true;
let unicodeCharacters = savedAsciiPreset?.unicode ?? false;
let asciiRebuildTimer: number | null = null;
let lastAsciiFrame = 0;
let lastAnimationTime = 0;
let autoRotateEnabled = savedAsciiPreset?.autoRotate ?? true;
let spinAngle = savedAsciiPreset?.viewport?.spinAngle ?? 0;
let panPointerId: number | null = null;
let panPointerX = 0;
let panPointerY = 0;
let panelDragPointerId: number | null = null;
let panelDragOffsetX = 0;
let panelDragOffsetY = 0;
let asciiFrameCount = 0;
let asciiFpsWindowStart = 0;
let asciiFpsValue = 0;
const viewportPan = {
  x: savedAsciiPreset?.viewport?.pan?.x ?? 0,
  y: savedAsciiPreset?.viewport?.pan?.y ?? 0,
};
const geometricOrbitTarget = new THREE.Vector3();
const roughnessMaterials = new Set<THREE.MeshStandardMaterial>();
let materialRoughnessOverride = savedAsciiPreset?.materialRoughness !== null
  && savedAsciiPreset?.materialRoughness !== undefined;

function panelBounds(): { maxLeft: number; maxTop: number } {
  const rect = controlPanel.getBoundingClientRect();
  return {
    maxLeft: Math.max(8, window.innerWidth - rect.width - 8),
    maxTop: Math.max(8, window.innerHeight - rect.height - 8),
  };
}

function positionControlPanel(left: number, top: number): void {
  const { maxLeft, maxTop } = panelBounds();
  controlPanel.style.left = `${clamp(left, 8, maxLeft)}px`;
  controlPanel.style.top = `${clamp(top, 8, maxTop)}px`;
  controlPanel.style.right = 'auto';
}

function keepControlPanelOnScreen(): void {
  if (controlPanel.hidden || !controlPanel.style.left) return;
  const rect = controlPanel.getBoundingClientRect();
  positionControlPanel(rect.left, rect.top);
}

function beginPanelDrag(event: PointerEvent): void {
  if (event.button !== 0) return;
  event.preventDefault();
  const rect = controlPanel.getBoundingClientRect();
  panelDragPointerId = event.pointerId;
  panelDragOffsetX = event.clientX - rect.left;
  panelDragOffsetY = event.clientY - rect.top;
  positionControlPanel(rect.left, rect.top);
  controlPanel.classList.add('is-dragging');
  controlPanelDragHandle.setPointerCapture?.(event.pointerId);
}

function dragControlPanel(event: PointerEvent): void {
  if (event.pointerId !== panelDragPointerId) return;
  positionControlPanel(event.clientX - panelDragOffsetX, event.clientY - panelDragOffsetY);
}

function endPanelDrag(event?: PointerEvent): void {
  if (panelDragPointerId === null) return;
  const pointerId = panelDragPointerId;
  panelDragPointerId = null;
  controlPanel.classList.remove('is-dragging');
  if (event?.pointerId === pointerId && controlPanelDragHandle.hasPointerCapture?.(pointerId)) {
    controlPanelDragHandle.releasePointerCapture(pointerId);
  }
}

function setControlPanelOpen(open: boolean): void {
  endPanelDrag();
  controlPanel.hidden = !open;
  controlPanel.setAttribute('aria-hidden', String(!open));
  controlsOpen.hidden = open;
  controlsOpen.setAttribute('aria-expanded', String(open));
  if (open) {
    window.requestAnimationFrame(() => {
      keepControlPanelOnScreen();
      controlsClose.focus({ preventScroll: true });
    });
  } else {
    controlsOpen.focus({ preventScroll: true });
  }
}

function applyMaterialRoughness(value: number): void {
  const roughness = clamp(value, 0, 1);
  roughnessMaterials.forEach((material) => {
    material.roughness = roughness;
    material.needsUpdate = true;
  });
  materialRoughnessOutput.value = roughness.toFixed(2);
  lastAsciiFrame = 0;
}

function setAsciiFpsState(state: 'inactive' | 'warming' | 'active'): void {
  const ready = state === 'active';
  asciiFps.dataset.fpsState = state;
  asciiFps.dataset.fpsReady = String(ready);
  asciiFps.dataset.fpsValue = ready ? asciiFpsValue.toFixed(1) : '0';
  asciiFps.textContent = state === 'inactive'
    ? 'ASCII FPS · OFF'
    : ready
      ? `ASCII FPS · ${asciiFpsValue.toFixed(1)}`
      : 'ASCII FPS · …';
}

function resetAsciiFps(state: 'inactive' | 'warming'): void {
  asciiFrameCount = 0;
  asciiFpsWindowStart = 0;
  asciiFpsValue = 0;
  setAsciiFpsState(state);
}

function recordAsciiFrame(): void {
  const now = performance.now();
  if (asciiFpsWindowStart === 0) asciiFpsWindowStart = now;
  asciiFrameCount += 1;
  const elapsed = now - asciiFpsWindowStart;
  if (elapsed < 1000) return;
  asciiFpsValue = asciiFrameCount / (elapsed / 1000);
  asciiFrameCount = 0;
  asciiFpsWindowStart = now;
  setAsciiFpsState('active');
}

function applyViewportPan() {
  const width = Math.max(1, stage.clientWidth);
  const height = Math.max(1, stage.clientHeight);
  if (Math.abs(viewportPan.x) < 0.0001 && Math.abs(viewportPan.y) < 0.0001) {
    camera.clearViewOffset();
  } else {
    camera.setViewOffset(
      width,
      height,
      -viewportPan.x * width,
      -viewportPan.y * height,
      width,
      height,
    );
  }
  camera.updateProjectionMatrix();
}

function applyDefaultTilt() {
  if (!tiltRoot) return;
  tiltRoot.rotation.z = THREE.MathUtils.degToRad(Number(defaultTilt.value));
}

function panFromPointer(event: PointerEvent): void {
  if (panPointerId !== event.pointerId) return;
  const width = Math.max(1, stage.clientWidth);
  const height = Math.max(1, stage.clientHeight);
  viewportPan.x += (event.clientX - panPointerX) / width;
  viewportPan.y += (event.clientY - panPointerY) / height;
  panPointerX = event.clientX;
  panPointerY = event.clientY;
  viewportPan.x = clamp(viewportPan.x, -1, 1);
  viewportPan.y = clamp(viewportPan.y, -1, 1);
  applyViewportPan();
  lastAsciiFrame = 0;
}

function beginViewportPan(event: PointerEvent): void {
  if (event.button !== 2) return;
  event.preventDefault();
  panPointerId = event.pointerId;
  panPointerX = event.clientX;
  panPointerY = event.clientY;
  renderer.domElement.setPointerCapture?.(event.pointerId);
  renderer.domElement.style.cursor = 'grabbing';
}

function finishViewportPan(event?: PointerEvent): void {
  if (panPointerId === null) return;
  const capturedPointerId = panPointerId;
  panPointerId = null;
  renderer.domElement.style.cursor = '';
  if (
    event?.pointerId === capturedPointerId
    && renderer.domElement.hasPointerCapture?.(capturedPointerId)
  ) {
    renderer.domElement.releasePointerCapture(capturedPointerId);
  }
}

function rebuildAsciiEffect() {
  if (asciiEffect) {
    asciiEffect.dispose();
    asciiEffect.domElement.remove();
  }
  gpuAsciiEffect?.dispose();
  gpuAsciiEffect = null;

  const characterSize = Number(asciiSize.value);
  const options = {
    color: asciiColor,
    colorBrightness: Number(asciiBrightness.value),
    colorSaturation: Number(asciiSaturation.value),
    luminanceCurve,
    resolution: 2 / characterSize,
  };
  if (gpuRendererEnabled) {
    gpuAsciiEffect = new GpuGlyphEffect(renderer, unicodeCharacters ? UNICODE_CHARACTERS : ASCII_CHARACTERS, options);
    gpuAsciiEffect.setSize(stage.clientWidth, stage.clientHeight);
  } else {
    asciiEffect = new GlyphEffect(renderer, unicodeCharacters ? UNICODE_CHARACTERS : ASCII_CHARACTERS, {
      ...options,
      samplingBackend,
    });
    asciiEffect.domElement.className = 'ascii-output';
    asciiEffect.domElement.setAttribute('aria-hidden', 'true');
    stage.prepend(asciiEffect.domElement);
    asciiEffect.setSize(stage.clientWidth, stage.clientHeight);
  }
  resetAsciiFps(asciiEnabled ? 'warming' : 'inactive');
  lastAsciiFrame = 0;
}

function restoreSavedViewport(): void {
  if (!modelRoot) return;
  const resetPreset = publishedHomePreset;
  const previousDamping = controls.enableDamping;
  controls.enableDamping = false;
  // Consume any residual orbit/pan deltas before restoring the exact saved
  // camera. A second update below then applies the saved state with no inertia.
  controls.update();

  if (resetPreset.viewport) {
    const { cameraPosition } = resetPreset.viewport;
    camera.position.set(cameraPosition.x, cameraPosition.y, cameraPosition.z);
    spinAngle = resetPreset.viewport.spinAngle;
    modelRoot.rotation.y = spinAngle;
    viewportPan.x = resetPreset.viewport.pan.x;
    viewportPan.y = resetPreset.viewport.pan.y;
  } else {
    camera.position.copy(homePosition);
    spinAngle = 0;
    modelRoot.rotation.y = spinAngle;
    viewportPan.x = 0;
    viewportPan.y = 0;
  }
  defaultTilt.value = String(resetPreset.defaultTilt);
  defaultTiltOutput.value = `${defaultTilt.value}°`;
  applyDefaultTilt();
  applyViewportPan();
  controls.target.copy(geometricOrbitTarget);
  controls.update();
  controls.enableDamping = previousDamping;
  publishViewportState();
}

function publishViewportState(): void {
  asciiProfile.dataset.viewportCameraX = camera.position.x.toFixed(6);
  asciiProfile.dataset.viewportCameraY = camera.position.y.toFixed(6);
  asciiProfile.dataset.viewportCameraZ = camera.position.z.toFixed(6);
  asciiProfile.dataset.viewportSpinAngle = spinAngle.toFixed(6);
  asciiProfile.dataset.viewportPanX = viewportPan.x.toFixed(6);
  asciiProfile.dataset.viewportPanY = viewportPan.y.toFixed(6);
  asciiProfile.dataset.viewportDefaultTilt = defaultTilt.value;
}

function queueAsciiRebuild(): void {
  if (asciiRebuildTimer !== null) window.clearTimeout(asciiRebuildTimer);
  asciiRebuildTimer = window.setTimeout(rebuildAsciiEffect, 80);
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function pointToSvg(point: LuminancePoint): { x: number; y: number } {
  return {
    x: CURVE_PLOT.left + point.x * CURVE_PLOT.width,
    y: CURVE_PLOT.top + (1 - point.y) * CURVE_PLOT.height,
  };
}

function curveSlopes(points: LuminancePoint[]): number[] {
  if (points.length < 2) return [0];
  const secants = points.slice(0, -1).map((point, index) => {
    const next = points[index + 1];
    return (next.y - point.y) / Math.max(0.000001, next.x - point.x);
  });
  const slopes = [secants[0]];
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
  slopes.push(secants[secants.length - 1]);
  return slopes;
}

function curveLabel(): string {
  const hasLiftedShadows = luminanceCurve.some((point) => point.x > 0.05 && point.x < 0.45 && point.y > point.x + 0.06);
  const hasRolledHighlights = luminanceCurve.some((point) => point.x > 0.55 && point.x < 0.95 && point.y < point.x - 0.06);
  if (hasLiftedShadows && hasRolledHighlights) return 'S-CURVE';
  if (hasLiftedShadows) return 'SHADOW LIFT';
  if (hasRolledHighlights) return 'HIGHLIGHT ROLL-OFF';
  if (luminanceCurve.every((point) => Math.abs(point.y - point.x) < 0.025)) return 'LINEAR';
  return 'CUSTOM CURVE';
}

function commitCurve(): void {
  luminanceCurve.sort((a: LuminancePoint, b: LuminancePoint) => a.x - b.x);
  // Endpoints are always fixed anchors; sort first so a newly inserted
  // interior point can never be overwritten as the final item.
  luminanceCurve[0] = { x: 0, y: 0 };
  luminanceCurve[luminanceCurve.length - 1] = { x: 1, y: 1 };
  let previousY = 0;
  for (let index = 1; index < luminanceCurve.length - 1; index += 1) {
    luminanceCurve[index].y = clamp(luminanceCurve[index].y, previousY, 1);
    previousY = luminanceCurve[index].y;
  }
  for (let index = luminanceCurve.length - 2; index > 0; index -= 1) {
    luminanceCurve[index].y = clamp(luminanceCurve[index].y, 0, luminanceCurve[index + 1].y);
  }
  asciiEffect?.setLuminanceCurve(luminanceCurve);
  gpuAsciiEffect?.setLuminanceCurve(luminanceCurve);
  lastAsciiFrame = 0;
  renderCurve();
}

function svgCurveControlPoints() {
  const slopes = curveSlopes(luminanceCurve);
  return luminanceCurve.slice(0, -1).map((point, index) => {
    const next = luminanceCurve[index + 1];
    const start = pointToSvg(point);
    const end = pointToSvg(next);
    const span = next.x - point.x;
    return {
      start,
      end,
      control1: {
        x: start.x + (CURVE_PLOT.width * span) / 3,
        y: start.y - (CURVE_PLOT.height * span * slopes[index]) / 3,
      },
      control2: {
        x: end.x - (CURVE_PLOT.width * span) / 3,
        y: end.y + (CURVE_PLOT.height * span * slopes[index + 1]) / 3,
      },
    };
  });
}

function renderCurve() {
  const controls = svgCurveControlPoints();
  let pathData = `M${controls[0].start.x.toFixed(2)} ${controls[0].start.y.toFixed(2)}`;
  controls.forEach((segment) => {
    pathData += ` C${segment.control1.x.toFixed(2)} ${segment.control1.y.toFixed(2)}`
      + ` ${segment.control2.x.toFixed(2)} ${segment.control2.y.toFixed(2)}`
      + ` ${segment.end.x.toFixed(2)} ${segment.end.y.toFixed(2)}`;
  });
  curvePath.setAttribute('d', pathData);
  curveValue.value = curveLabel();
  curveValue.textContent = curveLabel();

  curvePointsGroup.replaceChildren();
  luminanceCurve.forEach((point, index) => {
    const { x, y } = pointToSvg(point);
    const control = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    control.classList.add('curve-graph__point');
    if (activeCurvePoint === index) control.classList.add('is-active');
    control.id = `curve-point-${index}`;
    control.setAttribute('cx', x.toFixed(2));
    control.setAttribute('cy', y.toFixed(2));
    control.setAttribute('r', index === 0 || index === luminanceCurve.length - 1 ? '3.2' : '3.8');
    control.setAttribute('data-index', String(index));
    control.setAttribute('role', 'slider');
    control.setAttribute('aria-label', `Luminance transfer point ${index + 1}`);
    control.setAttribute('aria-valuemin', '0');
    control.setAttribute('aria-valuemax', '100');
    control.setAttribute('aria-valuenow', String(Math.round(point.y * 100)));
    control.setAttribute('aria-valuetext', `${Math.round(point.x * 100)}% source, ${Math.round(point.y * 100)}% output`);
    const isEndpoint = index === 0 || index === luminanceCurve.length - 1;
    control.setAttribute('aria-disabled', String(isEndpoint));
    control.setAttribute('tabindex', asciiEnabled && !isEndpoint ? '0' : '-1');
    control.addEventListener('keydown', adjustCurvePointWithKeyboard);
    curvePointsGroup.append(control);

    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    hit.classList.add('curve-graph__hit');
    hit.setAttribute('cx', x.toFixed(2));
    hit.setAttribute('cy', y.toFixed(2));
    hit.setAttribute('r', '8');
    hit.setAttribute('data-index', String(index));
    hit.setAttribute('aria-hidden', 'true');
    if (!isEndpoint) {
      hit.addEventListener('pointerdown', beginCurveDrag);
      hit.addEventListener('dblclick', removeCurvePoint);
    }
    curvePointsGroup.insertBefore(hit, control);
  });
  if (activeCurvePoint !== null && asciiEnabled) {
    const activeControl = document.querySelector(`#curve-point-${activeCurvePoint}`) as SVGCircleElement | null;
    activeControl?.focus({ preventScroll: true });
  }
}

function updateCurveFromPointer(event: PointerEvent): void {
  if (activeCurvePoint === null || !asciiEnabled) return;
  const rect = curveGraph.getBoundingClientRect();
  const svgX = ((event.clientX - rect.left) / rect.width) * 240;
  const svgY = ((event.clientY - rect.top) / rect.height) * 132;
  const point = luminanceCurve[activeCurvePoint];
  if (!point) return;
  suppressCurveClick = true;

  if (activeCurvePoint > 0 && activeCurvePoint < luminanceCurve.length - 1) {
    const previous = luminanceCurve[activeCurvePoint - 1];
    const next = luminanceCurve[activeCurvePoint + 1];
    point.x = clamp((svgX - CURVE_PLOT.left) / CURVE_PLOT.width, previous.x + 0.02, next.x - 0.02);
  }
  point.y = clamp(1 - (svgY - CURVE_PLOT.top) / CURVE_PLOT.height);
  commitCurve();
}

function beginCurveDrag(event: PointerEvent): void {
  if (!asciiEnabled) return;
  event.preventDefault();
  event.stopPropagation();
  suppressCurveClick = false;
  const target = event.currentTarget as SVGCircleElement;
  activeCurvePoint = Number(target.dataset.index);
  target.setPointerCapture?.(event.pointerId);
  curveGraph.setPointerCapture?.(event.pointerId);
  renderCurve();
}

function endCurveDrag(event?: PointerEvent): void {
  activeCurvePoint = null;
  if (event?.pointerId !== undefined) curveGraph.releasePointerCapture?.(event.pointerId);
  renderCurve();
  if (suppressCurveClick) window.setTimeout(() => { suppressCurveClick = false; }, 0);
}

function removeCurvePoint(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
  const target = event.currentTarget as SVGCircleElement;
  const index = Number(target.dataset.index);
  if (index === 0 || index === luminanceCurve.length - 1 || luminanceCurve.length <= 2) return;
  luminanceCurve.splice(index, 1);
  activeCurvePoint = null;
  commitCurve();
}

function addCurvePoint(event: MouseEvent): void {
  if (!asciiEnabled || suppressCurveClick || luminanceCurve.length >= MAX_CURVE_POINTS) return;
  if (event.target !== curvePlot) return;
  const rect = curveGraph.getBoundingClientRect();
  const svgX = ((event.clientX - rect.left) / rect.width) * 240;
  const svgY = ((event.clientY - rect.top) / rect.height) * 132;
  const x = clamp((svgX - CURVE_PLOT.left) / CURVE_PLOT.width);
  const y = clamp(1 - (svgY - CURVE_PLOT.top) / CURVE_PLOT.height);
  if (x <= 0.02 || x >= 0.98 || luminanceCurve.some((point) => Math.abs(point.x - x) < 0.035)) return;
  luminanceCurve.push({ x, y });
  commitCurve();
}

function adjustCurvePointWithKeyboard(event: KeyboardEvent): void {
  if (!asciiEnabled) return;
  const target = event.currentTarget as SVGCircleElement;
  const index = Number(target.dataset.index);
  const point = luminanceCurve[index];
  if (!point || index === 0 || index === luminanceCurve.length - 1) return;
  if ((event.key === 'Delete' || event.key === 'Backspace') && index > 0 && index < luminanceCurve.length - 1) {
    event.preventDefault();
    luminanceCurve.splice(index, 1);
    commitCurve();
    return;
  }
  const step = event.shiftKey ? 0.1 : 0.02;
  let handled = true;
  switch (event.key) {
    case 'ArrowUp': point.y += step; break;
    case 'ArrowDown': point.y -= step; break;
    case 'ArrowLeft': point.x -= step; break;
    case 'ArrowRight': point.x += step; break;
    case 'Home': point.y = 0; break;
    case 'End': point.y = 1; break;
    default: handled = false;
  }
  if (!handled) return;
  event.preventDefault();
  if (index > 0 && index < luminanceCurve.length - 1) {
    point.x = clamp(point.x, luminanceCurve[index - 1].x + 0.02, luminanceCurve[index + 1].x - 0.02);
  } else {
    point.x = index === 0 ? 0 : 1;
  }
  point.y = clamp(point.y);
  commitCurve();
}

curveGraph.addEventListener('pointermove', updateCurveFromPointer);
curveGraph.addEventListener('pointerup', endCurveDrag);
curveGraph.addEventListener('pointercancel', endCurveDrag);
curveGraph.addEventListener('click', addCurvePoint);
curveGraph.addEventListener('pointerleave', (event) => {
  if (activeCurvePoint !== null && event.buttons === 0) endCurveDrag();
});
curveReset.addEventListener('click', () => {
  luminanceCurve = DEFAULT_CURVE.map((point) => ({ ...point }));
  commitCurve();
});

function currentAsciiPreset(): AsciiPreset | null {
  return normalizeAsciiPreset({
    color: asciiColor,
    unicode: unicodeCharacters,
    glyphSize: Number(asciiSize.value),
    colorBrightness: Number(asciiBrightness.value),
    colorSaturation: Number(asciiSaturation.value),
    materialRoughness: roughnessMaterials.size > 0 && materialRoughnessOverride
      ? Number(materialRoughness.value)
      : null,
    rotationSpeed: Number(rotationSpeed.value),
    defaultTilt: Number(defaultTilt.value),
    autoRotate: autoRotateEnabled,
    luminanceCurve,
    viewport: modelRoot ? {
      cameraPosition: {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
      },
      spinAngle,
      pan: { x: viewportPan.x, y: viewportPan.y },
    } : null,
  });
}

curveSave.addEventListener('click', () => {
  const preset = currentAsciiPreset();
  const saved = preset ? saveAsciiPreset(preset) : false;

  curveSave.textContent = saved ? 'SAVED' : 'SAVE FAILED';
  window.setTimeout(() => {
    curveSave.textContent = 'SAVE DRAFT';
  }, 1600);
});

presetPublish.addEventListener('click', async () => {
  const preset = currentAsciiPreset();
  if (!preset) {
    presetPublish.textContent = 'PUBLISH FAILED';
    return;
  }

  saveAsciiPreset(preset);
  presetPublish.disabled = true;
  presetPublish.textContent = 'PUBLISHING…';
  try {
    const response = await fetch('/__publish-home-preset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(preset),
    });
    if (!response.ok) throw new Error(`Publish failed with status ${response.status}.`);
    presetPublish.textContent = 'PUBLISHED';
  } catch (error) {
    console.error('Unable to publish the homepage preset.', error);
    presetPublish.textContent = 'PUBLISH FAILED';
  } finally {
    window.setTimeout(() => {
      presetPublish.textContent = 'PUBLISH TO HOME';
      presetPublish.disabled = modelRoot === null;
    }, 1600);
  }
});

function updateAsciiControls() {
  asciiToggle.setAttribute('aria-pressed', String(asciiEnabled));
  asciiToggle.textContent = `ASCII: ${asciiEnabled ? 'ON' : 'OFF'}`;
  asciiColorToggle.disabled = !asciiEnabled;
  asciiCharsetToggle.disabled = !asciiEnabled;
  asciiBrightness.disabled = !asciiEnabled || !asciiColor;
  asciiSaturation.disabled = !asciiEnabled || !asciiColor;
  asciiSize.disabled = !asciiEnabled;
  curveReset.disabled = !asciiEnabled;
  curveSave.disabled = modelRoot === null;
  presetPublish.disabled = modelRoot === null || !import.meta.env.DEV;
  curveGraph.setAttribute('aria-disabled', String(!asciiEnabled));
  asciiColorToggle.setAttribute('aria-pressed', String(asciiColor));
  asciiColorToggle.textContent = `COLOR: ${asciiColor ? 'FULL' : 'B&W'}`;
  asciiCharsetToggle.setAttribute('aria-pressed', String(unicodeCharacters));
  asciiCharsetToggle.textContent = `GLYPHS: ${unicodeCharacters ? 'UNICODE' : 'ASCII'}`;
  asciiBrightnessOutput.value = `${asciiBrightness.value}%`;
  const saturation = Number(asciiSaturation.value);
  asciiSaturationOutput.value = saturation > 0 ? `+${saturation}` : String(saturation);
  asciiSizeValue.value = `${asciiSize.value} PX`;
  renderModeLabel.textContent = asciiEnabled
    ? `${unicodeCharacters ? 'UNICODE' : 'ASCII'} · ${asciiColor ? 'FULL COLOR' : 'B&W'}`
    : 'GLB · ORIGINAL TEXTURES';
  if (scene.background instanceof THREE.Color) {
    scene.background.setHex(asciiEnabled ? ASCII_BACKGROUND : ORIGINAL_BACKGROUND);
  }
  if (grid) grid.visible = !asciiEnabled;
  stage.classList.toggle('is-ascii', asciiEnabled);
  stage.classList.toggle('is-gpu-ascii', asciiEnabled && gpuRendererEnabled);
  renderCurve();
}

function frameModel(size: THREE.Vector3): void {
  const radius = Math.max(size.x, size.y, size.z) * 0.5;
  const distance = radius / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * 1.18;

  homePosition.set(distance * 0.66, distance * 0.3, distance);
  camera.position.copy(homePosition);
  camera.near = Math.max(radius / 100, 0.01);
  camera.far = radius * 30;
  camera.updateProjectionMatrix();

  controls.target.copy(geometricOrbitTarget);
  controls.minDistance = radius * 0.7;
  controls.maxDistance = radius * 8;
  controls.update();
}

loadProtea(
  (gltf) => {
    const model = gltf.scene;
    let meshes = 0;
    let triangles = 0;

    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      meshes += 1;
      const geometry = object.geometry;
      triangles += geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;

      // Defensive fallback for replacement assets that arrive without normals.
      // The checked-in protea keeps its authored normals for the best shading.
      if (!geometry.getAttribute('normal')) {
        geometry.computeVertexNormals();
      }

      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material: THREE.Material | null) => {
        if (!material) return;
        material.side = THREE.DoubleSide;
        const texturedMaterial = material as THREE.MeshStandardMaterial;
        if (material instanceof THREE.MeshStandardMaterial) {
          roughnessMaterials.add(material);
        }
        if (texturedMaterial.map) {
          texturedMaterial.map.anisotropy = renderer.capabilities.getMaxAnisotropy();
          texturedMaterial.map.needsUpdate = true;
        }
        material.needsUpdate = true;
      });
    });

    if (roughnessMaterials.size > 0) {
      const savedRoughness = savedAsciiPreset?.materialRoughness;
      const authoredAverage = (
        Array.from(roughnessMaterials).reduce((sum, material) => sum + material.roughness, 0)
        / roughnessMaterials.size
      );
      const initialRoughness = savedRoughness ?? authoredAverage;
      materialRoughness.value = initialRoughness.toFixed(2);
      materialRoughness.disabled = false;
      materialRoughnessOutput.value = initialRoughness.toFixed(2);
      if (savedRoughness !== null && savedRoughness !== undefined) {
        applyMaterialRoughness(savedRoughness);
      }
    }

    const orientation = new THREE.Group();
    orientation.rotation.x = -Math.PI / 2;
    orientation.add(model);
    orientation.updateMatrixWorld(true);

    // Translate the fully oriented asset so its world-space bounding-box
    // center sits exactly at the pivot origin.
    const orientedBounds = new THREE.Box3().setFromObject(orientation);
    const geometricCenter = orientedBounds.getCenter(new THREE.Vector3());
    orientation.position.sub(geometricCenter);

    modelRoot = new THREE.Group();
    tiltRoot = new THREE.Group();
    tiltRoot.add(orientation);
    modelRoot.add(tiltRoot);
    scene.add(modelRoot);
    modelRoot.updateMatrixWorld(true);
    modelRoot.getWorldPosition(geometricOrbitTarget);
    applyDefaultTilt();

    const uprightBounds = new THREE.Box3().setFromObject(modelRoot);
    const uprightSize = uprightBounds.getSize(new THREE.Vector3());

    const gridSize = Math.max(uprightSize.x, uprightSize.y, uprightSize.z) * 1.6;
    grid = new THREE.GridHelper(gridSize, 20, 0x5d5d5d, 0x292929);
    grid.position.y = -uprightSize.y * 0.5;
    grid.visible = !asciiEnabled;
    scene.add(grid);

    meshCount.textContent = `${meshes.toLocaleString()} ${meshes === 1 ? 'MESH' : 'MESHES'}`;
    triangleCount.textContent = `${Math.round(triangles).toLocaleString()} TRIANGLES`;
    status.classList.add('is-hidden');
    stage.classList.add('is-ready');
    frameModel(uprightSize);
    if (savedAsciiPreset?.viewport) {
      const { cameraPosition } = savedAsciiPreset.viewport;
      camera.position.set(cameraPosition.x, cameraPosition.y, cameraPosition.z);
      modelRoot.rotation.y = spinAngle;
      applyDefaultTilt();
      controls.target.copy(geometricOrbitTarget);
      controls.update();
    }
    publishViewportState();
    updateAsciiControls();
  },
  (error) => {
    console.error('Unable to load the edited king protea.', error);
    status.textContent = 'MODEL COULD NOT BE LOADED';
    status.classList.add('is-error');
  },
);

rotateToggle.addEventListener('click', () => {
  autoRotateEnabled = !autoRotateEnabled;
  rotateToggle.setAttribute('aria-pressed', String(autoRotateEnabled));
  rotateToggle.textContent = `AUTO-ROTATE: ${autoRotateEnabled ? 'ON' : 'OFF'}`;
});

resetButton.addEventListener('click', () => {
  restoreSavedViewport();
});

rotationSpeed.addEventListener('input', () => {
  rotationSpeedOutput.value = `${rotationSpeed.value}%`;
});

defaultTilt.addEventListener('input', () => {
  defaultTiltOutput.value = `${defaultTilt.value}°`;
  applyDefaultTilt();
});

materialRoughness.addEventListener('input', () => {
  materialRoughnessOverride = true;
  applyMaterialRoughness(Number(materialRoughness.value));
});

controlPanelDragHandle.addEventListener('pointerdown', beginPanelDrag);
controlPanelDragHandle.addEventListener('pointermove', dragControlPanel);
controlPanelDragHandle.addEventListener('pointerup', endPanelDrag);
controlPanelDragHandle.addEventListener('pointercancel', endPanelDrag);
controlPanelDragHandle.addEventListener('lostpointercapture', endPanelDrag);
controlsClose.addEventListener('click', () => setControlPanelOpen(false));
controlsOpen.addEventListener('click', () => setControlPanelOpen(true));
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !controlPanel.hidden) setControlPanelOpen(false);
});

asciiToggle.addEventListener('click', () => {
  asciiEnabled = !asciiEnabled;
  if (asciiEnabled && !asciiEffect && !gpuAsciiEffect) rebuildAsciiEffect();
  resetAsciiFps(asciiEnabled ? 'warming' : 'inactive');
  lastAsciiFrame = 0;
  updateAsciiControls();
});

window.addEventListener('ascii-profile-reset', () => {
  asciiEffect?.resetProfile();
  gpuAsciiEffect?.resetProfile();
});
window.addEventListener('ascii-viewport-restore', restoreSavedViewport);

asciiColorToggle.addEventListener('click', () => {
  asciiColor = !asciiColor;
  updateAsciiControls();
  rebuildAsciiEffect();
});

asciiCharsetToggle.addEventListener('click', () => {
  unicodeCharacters = !unicodeCharacters;
  updateAsciiControls();
  rebuildAsciiEffect();
});

asciiBrightness.addEventListener('input', () => {
  const value = Number(asciiBrightness.value);
  asciiBrightnessOutput.value = `${value}%`;
  asciiEffect?.setColorBrightness(value);
  gpuAsciiEffect?.setColorBrightness(value);
  lastAsciiFrame = 0;
});

asciiSaturation.addEventListener('input', () => {
  const value = Number(asciiSaturation.value);
  asciiSaturationOutput.value = value > 0 ? `+${value}` : String(value);
  asciiEffect?.setColorSaturation(value);
  gpuAsciiEffect?.setColorSaturation(value);
  lastAsciiFrame = 0;
});

asciiSize.addEventListener('input', () => {
  asciiSizeValue.value = `${asciiSize.value} PX`;
  queueAsciiRebuild();
});

function resize(): void {
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  asciiEffect?.setSize(width, height);
  gpuAsciiEffect?.setSize(width, height);
  applyViewportPan();
  keepControlPanelOnScreen();
}

function animate(time: number): void {
  const delta = lastAnimationTime === 0 ? 0 : Math.min((time - lastAnimationTime) / 1000, 0.05);
  lastAnimationTime = time;
  if (modelRoot) {
    if (autoRotateEnabled) {
      spinAngle += delta * BASE_ROTATION_RATE * (Number(rotationSpeed.value) / 100);
      modelRoot.rotation.y = spinAngle;
    }
  }
  controls.update();
  if (!asciiEnabled) {
    renderer.render(scene, camera);
    return;
  }

  if (gpuAsciiEffect) {
    gpuAsciiEffect.render(scene, camera);
    recordAsciiFrame();
    lastAsciiFrame = time;
    return;
  }

  const targetFps = 60;
  const frameInterval = 1000 / targetFps;
  if (asciiEffect && time - lastAsciiFrame >= frameInterval) {
    asciiEffect.render(scene, camera);
    recordAsciiFrame();
    lastAsciiFrame = time;
  }
}

window.addEventListener('resize', resize);
renderer.domElement.addEventListener('pointerdown', beginViewportPan);
renderer.domElement.addEventListener('pointermove', panFromPointer);
renderer.domElement.addEventListener('pointerup', finishViewportPan);
renderer.domElement.addEventListener('pointercancel', finishViewportPan);
renderer.domElement.addEventListener('lostpointercapture', finishViewportPan);
renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
window.addEventListener('blur', () => finishViewportPan());
resize();
updateAsciiControls();
rotateToggle.setAttribute('aria-pressed', String(autoRotateEnabled));
rotateToggle.textContent = `AUTO-ROTATE: ${autoRotateEnabled ? 'ON' : 'OFF'}`;
rotationSpeedOutput.value = `${rotationSpeed.value}%`;
defaultTiltOutput.value = `${defaultTilt.value}°`;
resetAsciiFps('inactive');
renderer.setAnimationLoop(animate);
