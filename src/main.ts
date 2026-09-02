import * as THREE from 'three';
import { AsciiEffect } from 'three/examples/jsm/effects/AsciiEffect.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GlyphEffect } from './GlyphEffect';
import { GpuGlyphEffect } from './GpuGlyphEffect';
import { BASE_ROTATION_RATE, normalizeAsciiPreset } from './asciiPreset';
import type { AsciiPreset } from './asciiPreset';
import { containsScreenPoint, createFlowerBoundsProjector, getLocalFlowerBounds } from './flowerInteractionBounds';
import type { ScreenBounds } from './flowerInteractionBounds';
import { loadProtea } from './model/loadProtea';
import publishedHomePresetJson from './publishedHomePreset.json';
import './styles.css';

const stage = document.querySelector('#ascii-stage') as HTMLElement;
const viewportHelp = document.querySelector('.viewport-help') as HTMLElement | null;
const reducedMotionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: { mobile?: boolean; platform?: string };
};

const navigatorWithUserAgentData = navigator as NavigatorWithUserAgentData;
const reportedPlatform = navigatorWithUserAgentData.userAgentData?.platform
  || navigator.platform
  || navigator.userAgent;
const isMacPlatform = /Mac/i.test(reportedPlatform)
  && !/iPhone|iPad|iPod/i.test(navigator.userAgent);
const isMobileOrTabletUserAgent = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet/i
  .test(navigator.userAgent);
const isIpadDesktopMode = /Mac/i.test(reportedPlatform) && navigator.maxTouchPoints > 1;
const isMobileOrTablet = navigatorWithUserAgentData.userAgentData?.mobile === true
  || isMobileOrTabletUserAgent
  || isIpadDesktopMode;
const zoomInstruction = document.querySelector('#zoom-instruction');
if (zoomInstruction) {
  zoomInstruction.textContent = isMacPlatform
    ? 'Pinch or ⌘ + scroll to zoom'
    : 'Pinch or Ctrl + scroll to zoom';
}

const ASCII_CHARACTERS = ' .,:;irsXA253hMHGS#9B&@';
const UNICODE_CHARACTERS = '  ·˙⠁⠃⠇⠏⠟⠿⡿⣿░▒▓█';
const normalizedPublishedHomePreset = normalizeAsciiPreset(publishedHomePresetJson);
if (!normalizedPublishedHomePreset) throw new Error('The published homepage preset is invalid.');
const savedAsciiPreset: AsciiPreset = normalizedPublishedHomePreset;
const savedMaterialRoughness = savedAsciiPreset?.materialRoughness ?? null;
const rendererQuery = new URLSearchParams(window.location.search).get('asciiRenderer');
const legacyTargetRequested = new URLSearchParams(window.location.search).get('asciiSampler') === 'target';
const useGpuAscii = Boolean(savedAsciiPreset)
  && rendererQuery !== 'dom'
  && !(legacyTargetRequested && rendererQuery === null);
const savedPan = {
  x: savedAsciiPreset?.viewport?.pan?.x ?? 0,
  y: savedAsciiPreset?.viewport?.pan?.y ?? 0,
};

// The saved viewport is the source of truth for the viewer. The homepage adds a
// gentle, width-aware horizontal composition bias so the flower reads as a
// right-side hero element while the title remains in the upper-left copy block.
// Keep this separate from `savedPan`: viewer and published preset values must
// remain exact, and the camera projector below automatically follows the
// resulting view offset for hover interaction.
function homepageHorizontalCompositionAdjustment(width: number): number {
  return THREE.MathUtils.clamp(0.44 - width * 0.00006, 0.30, 0.42);
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(savedAsciiPreset ? 0x000000 : 0xffffff);

const camera = new THREE.PerspectiveCamera(savedAsciiPreset ? 34 : 32, 1, 0.1, savedAsciiPreset ? 10000 : 100);
if (!savedAsciiPreset) camera.position.set(0, 0.15, 4.6);

const renderer = new THREE.WebGLRenderer({
  antialias: Boolean(savedAsciiPreset),
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(savedAsciiPreset ? Math.min(window.devicePixelRatio, 2) : 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(scene.background, 1);
if (savedAsciiPreset) {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
}

const asciiCharacters = savedAsciiPreset?.unicode ? UNICODE_CHARACTERS : ASCII_CHARACTERS;
const asciiOptions = savedAsciiPreset ? {
  color: savedAsciiPreset.color,
  colorBrightness: savedAsciiPreset.colorBrightness,
  colorSaturation: savedAsciiPreset.colorSaturation,
  luminanceCurve: savedAsciiPreset.luminanceCurve,
  resolution: 2 / savedAsciiPreset.glyphSize,
} : null;
const gpuEffect = useGpuAscii && asciiOptions
  ? new GpuGlyphEffect(renderer, asciiCharacters, asciiOptions)
  : null;
const domEffect = gpuEffect
  ? null
  : savedAsciiPreset && asciiOptions
    ? new GlyphEffect(renderer, asciiCharacters, asciiOptions)
    : new AsciiEffect(renderer, ASCII_CHARACTERS, {
      invert: false,
      resolution: 0.19,
      scale: 1,
      color: false,
      alpha: false,
      block: false,
    });
const effect = (gpuEffect ?? domEffect)!;
const effectElement = gpuEffect ? renderer.domElement : domEffect!.domElement;
if (gpuEffect) {
  renderer.domElement.className = 'ascii-gpu-output';
  renderer.domElement.setAttribute('aria-hidden', 'true');
} else {
  effectElement.className = 'ascii-output';
  effectElement.setAttribute('aria-hidden', 'true');
}
stage.prepend(effectElement);
stage.classList.toggle('has-saved-preset', Boolean(savedAsciiPreset));
stage.classList.toggle('is-gpu-ascii', Boolean(gpuEffect));
stage.dataset.asciiBackend = gpuEffect ? 'gpu' : 'dom';

function createCameraControls(): OrbitControls {
  const next = new OrbitControls(camera, effectElement);
  next.enableDamping = true;
  next.dampingFactor = 0.055;
  next.enablePan = true;
  next.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  next.mouseButtons.MIDDLE = null;
  next.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  next.minDistance = 2.8;
  next.maxDistance = 7;
  // Camera gestures are mouse-only. Native touch scrolling remains available.
  effectElement.style.touchAction = 'auto';
  return next;
}

let controls = createCameraControls();
let projectFlowerBounds: ReturnType<typeof createFlowerBoundsProjector> | null = null;
let flowerScreenBounds: ScreenBounds | null = null;
let stageRect = stage.getBoundingClientRect();
let copyRect = document.querySelector('.homepage-copy')?.getBoundingClientRect() ?? null;
let pointerPosition: { x: number; y: number } | null = null;
let activePointerId: number | null = null;

function isInsideFlower(x: number, y: number): boolean {
  return !isMobileOrTablet && window.scrollY <= 1
    && containsScreenPoint(flowerScreenBounds, x, y)
    && !containsScreenPoint(copyRect, x, y);
}

function cancelCameraDrag(): void {
  if (activePointerId === null) return;
  const pointerId = activePointerId;
  activePointerId = null;
  const previous = controls;
  // Disconnect alone leaves OrbitControls' gesture state and damping intact.
  // Recreate through public APIs so leaving/scrolling/blur cannot resume a stale drag.
  previous.dispose();
  if (effectElement.hasPointerCapture(pointerId)) effectElement.releasePointerCapture(pointerId);
  controls = createCameraControls();
  controls.target.copy(previous.target);
  controls.minDistance = previous.minDistance;
  controls.maxDistance = previous.maxDistance;
  controls.update();
}

function updateFlowerHover(): void {
  const hovered = pointerPosition !== null && isInsideFlower(pointerPosition.x, pointerPosition.y);
  if (!hovered) cancelCameraDrag();
  controls.enabled = hovered;
  stage.classList.toggle('is-flower-hovered', hovered);
  document.documentElement.classList.toggle('is-flower-hovered', hovered);
  stage.dataset.cameraControls = hovered ? 'enabled' : 'disabled';
}

function updateFlowerInteractionBounds(): void {
  if (flower && projectFlowerBounds) {
    flower.updateWorldMatrix(true, false);
    camera.updateMatrixWorld();
    flowerScreenBounds = projectFlowerBounds(flower.matrixWorld, camera, stageRect, {
      left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
    });
  } else {
    flowerScreenBounds = null;
  }
  const boundsDescription = flowerScreenBounds
    ? [flowerScreenBounds.left, flowerScreenBounds.top, flowerScreenBounds.right, flowerScreenBounds.bottom]
      .map(Math.round).join(',')
    : '';
  if (stage.dataset.flowerBounds !== boundsDescription) stage.dataset.flowerBounds = boundsDescription;
  updateFlowerHover();
}

function applyDeviceInteractionMode(): void {
  const isAtTop = window.scrollY <= 1;
  const canControlCamera = !isMobileOrTablet && isAtTop;
  if (isAtTop) copyRect = document.querySelector('.homepage-copy')?.getBoundingClientRect() ?? null;
  effectElement.style.pointerEvents = canControlCamera ? 'auto' : 'none';
  document.documentElement.classList.toggle('is-scrolled', !isAtTop);
  document.documentElement.dataset.deviceMode = isMobileOrTablet ? 'mobile' : 'desktop';
  viewportHelp?.toggleAttribute('hidden', isMobileOrTablet || !isAtTop);
  updateFlowerHover();
}

applyDeviceInteractionMode();
window.addEventListener('scroll', applyDeviceInteractionMode, { passive: true });

const homepageCopy = document.querySelector('.homepage-copy');
if (homepageCopy) {
  // Async font swaps can resize the copy without a window resize or scroll.
  new ResizeObserver(() => {
    copyRect = homepageCopy.getBoundingClientRect();
    updateFlowerHover();
  }).observe(homepageCopy);
}

document.addEventListener('pointermove', (event) => {
  if (event.pointerType === 'touch') return;
  pointerPosition = { x: event.clientX, y: event.clientY };
  if (activePointerId === event.pointerId && event.buttons === 0) cancelCameraDrag();
  updateFlowerHover();
}, { capture: true, passive: true });

effectElement.addEventListener('pointerdown', (event) => {
  pointerPosition = event.pointerType === 'touch' ? null : { x: event.clientX, y: event.clientY };
  updateFlowerHover();
  if (!controls.enabled || activePointerId !== null || (event.button !== 0 && event.button !== 2)) {
    // Only stop the camera listener, preserving the browser's default action.
    event.stopImmediatePropagation();
    return;
  }
  activePointerId = event.pointerId;
}, { capture: true });

function endCameraPointer(event: PointerEvent): void {
  if (event.pointerId === activePointerId) activePointerId = null;
}
document.addEventListener('pointerup', endCameraPointer, { capture: true, passive: true });
document.addEventListener('pointercancel', endCameraPointer, { capture: true, passive: true });
effectElement.addEventListener('lostpointercapture', () => {
  cancelCameraDrag();
  updateFlowerHover();
});
function clearFlowerPointer(): void {
  pointerPosition = null;
  updateFlowerHover();
}
document.addEventListener('pointerout', (event) => {
  if (event.relatedTarget === null) clearFlowerPointer();
}, { passive: true });
window.addEventListener('blur', clearFlowerPointer);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearFlowerPointer();
});

effectElement.addEventListener('wheel', (event) => {
  pointerPosition = { x: event.clientX, y: event.clientY };
  updateFlowerHover();
  // Chromium/WebKit represent a trackpad pinch as a wheel event with ctrlKey,
  // even when the physical Control key is not being held.
  const isPinchOrControlZoom = event.ctrlKey;
  const isMacCommandZoom = isMacPlatform && event.metaKey;
  controls.enableZoom = isPinchOrControlZoom || isMacCommandZoom;
  if (controls.enabled && controls.enableZoom) {
    event.preventDefault();
  }
  // OrbitControls ignores ordinary wheel events; their page-scroll default and
  // propagation remain intact both inside and outside the flower.
}, { capture: true, passive: false });
effectElement.addEventListener('contextmenu', (event) => {
  pointerPosition = { x: event.clientX, y: event.clientY };
  updateFlowerHover();
}, { capture: true });

if (savedAsciiPreset) {
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
} else {
  scene.add(new THREE.HemisphereLight(0xffefff, 0x17131f, 2.4));

  const keyLight = new THREE.DirectionalLight(0xffffff, 4.6);
  keyLight.position.set(3, 4, 5);
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0xb974ff, 3.2);
  rimLight.position.set(-4, 1, -3);
  scene.add(rimLight);
}

let flower: THREE.Group | null = null;
let flowerTilt: THREE.Group | null = null;
let flowerBaseScale = 1;

function frameSavedModel(size: THREE.Vector3): void {
  if (!savedAsciiPreset || !flower) return;
  const radius = Math.max(size.x, size.y, size.z) * 0.5;
  const distance = radius / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * 1.18;

  camera.position.set(distance * 0.66, distance * 0.3, distance);
  camera.near = Math.max(radius / 100, 0.01);
  camera.far = radius * 30;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.minDistance = radius * 0.7;
  controls.maxDistance = radius * 8;

  flower.rotation.set(0, savedAsciiPreset?.viewport?.spinAngle ?? 0, 0);
  if (savedAsciiPreset?.viewport) {
    const { cameraPosition } = savedAsciiPreset.viewport;
    camera.position.set(cameraPosition.x, cameraPosition.y, cameraPosition.z);
  }
  controls.update();
}

loadProtea(
  (gltf) => {
    const model = gltf.scene;

    const fallbackMaterial = savedAsciiPreset ? null : new THREE.MeshStandardMaterial({
      color: 0x25102d,
      emissive: 0x08030a,
      emissiveIntensity: 0.18,
      roughness: 0.74,
      metalness: 0,
      side: THREE.DoubleSide,
    });

    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (fallbackMaterial) {
        object.material = fallbackMaterial;
        object.castShadow = false;
        object.receiveShadow = false;
        return;
      }
      if (!object.geometry.getAttribute('normal')) object.geometry.computeVertexNormals();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material: THREE.Material | null) => {
        if (!material) return;
        material.side = THREE.DoubleSide;
        const texturedMaterial = material as THREE.MeshStandardMaterial;
        if (
          savedMaterialRoughness !== null
          && material instanceof THREE.MeshStandardMaterial
        ) {
          material.roughness = savedMaterialRoughness;
        }
        if (texturedMaterial.map) {
          texturedMaterial.map.anisotropy = renderer.capabilities.getMaxAnisotropy();
          texturedMaterial.map.needsUpdate = true;
        }
        material.needsUpdate = true;
      });
    });

    if (savedAsciiPreset) {
      const orientation = new THREE.Group();
      orientation.rotation.x = -Math.PI / 2;
      orientation.add(model);
      orientation.updateMatrixWorld(true);

      const orientedBounds = new THREE.Box3().setFromObject(orientation);
      const geometricCenter = orientedBounds.getCenter(new THREE.Vector3());
      orientation.position.sub(geometricCenter);

      flower = new THREE.Group();
      flowerTilt = new THREE.Group();
      flowerTilt.add(orientation);
      flower.add(flowerTilt);
      scene.add(flower);
      flowerTilt.rotation.z = THREE.MathUtils.degToRad(savedAsciiPreset.defaultTilt);
      flower.updateMatrixWorld(true);

      const uprightSize = new THREE.Box3().setFromObject(flower).getSize(new THREE.Vector3());
      resize();
      frameSavedModel(uprightSize);
    } else {
      const bounds = new THREE.Box3().setFromObject(model);
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const targetSize = 2.2;
      const scale = targetSize / Math.max(size.x, size.y, size.z);
      flowerBaseScale = scale;

      const centeredAsset = new THREE.Group();
      centeredAsset.add(model);
      centeredAsset.position.sub(center);
      flower = new THREE.Group();
      flower.add(centeredAsset);
      flower.scale.setScalar(scale);
      flower.rotation.set(-0.12, -0.45, 0.18);
      flower.position.set(window.innerWidth > 700 ? 0.82 : 0, window.innerWidth > 700 ? 0 : 0.38, 0);
      scene.add(flower);
      resize();
    }

    if (flower) projectFlowerBounds = createFlowerBoundsProjector(getLocalFlowerBounds(flower));
    updateFlowerInteractionBounds();
    stage.classList.add('is-ready');
  },
  (error) => {
    console.error('Unable to load the king protea model.', error);
  },
);

const clock = new THREE.Clock();
let lastAsciiFrame = 0;

function resize() {
  stageRect = stage.getBoundingClientRect();
  copyRect = document.querySelector('.homepage-copy')?.getBoundingClientRect() ?? null;
  const width = stage.clientWidth;
  const height = stage.clientHeight;

  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  effect.setSize(width, height);

  if (savedAsciiPreset) {
    const homepagePanX = savedPan.x + homepageHorizontalCompositionAdjustment(width);
    if (Math.abs(homepagePanX) < 0.0001 && Math.abs(savedPan.y) < 0.0001) {
      camera.clearViewOffset();
    } else {
      camera.setViewOffset(width, height, -homepagePanX * width, -savedPan.y * height, width, height);
    }
    camera.updateProjectionMatrix();
  }

  if (flower && !savedAsciiPreset) {
    const mobileScale = width > 700 ? 1 : 0.66;
    flower.scale.setScalar(flowerBaseScale * mobileScale);
    flower.position.x = width > 700 ? 0.82 : 0;
    flower.position.y = width > 700 ? 0 : 0.3;
  }
  updateFlowerInteractionBounds();
}

function animate(time: number): void {
  const delta = Math.min(clock.getDelta(), 0.05);

  if (flower && !reducedMotionPreference.matches) {
    if (!savedAsciiPreset || savedAsciiPreset.autoRotate) {
      flower.rotation.y += delta * (savedAsciiPreset ? BASE_ROTATION_RATE * (savedAsciiPreset.rotationSpeed / 100) : 0.24);
    }
  }

  controls.update();
  updateFlowerInteractionBounds();
  if (gpuEffect) {
    gpuEffect.render(scene, camera);
    lastAsciiFrame = time;
    return;
  }
  const densityFactor = savedAsciiPreset
    ? Math.min(1, (savedAsciiPreset.glyphSize / 8) ** 2)
    : 1;
  const targetFps = savedAsciiPreset
    ? savedAsciiPreset.color
      ? Math.max(1, 12 * densityFactor)
      : Math.max(4, 20 * densityFactor)
    : 60;
  if (!savedAsciiPreset || time - lastAsciiFrame >= 1000 / targetFps) {
    effect.render(scene, camera);
    lastAsciiFrame = time;
  }
}

window.addEventListener('resize', resize);
resize();
renderer.setAnimationLoop(animate);
