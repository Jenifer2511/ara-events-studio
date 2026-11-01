import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureLoader?: { load(url: string): THREE.Texture };
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: profile.points.length === 6,
    bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 2,
    steps: 1,
  });
}

// Plan 1.3 F.6 — sweep a thin 2D cross-section along a 3D spine so a curved
// form (hooked blade, handle) reads correctly from EVERY camera angle, not just
// the reference angle a flat extrude happens to match. Uses ExtrudeGeometry's
// native extrudePath; bevelEnabled: false keeps sharp tips (same rule as F.5).
function buildCurveSweepGeometry(
  sweep: { spine: [number, number, number][]; crossSection: { points: [number, number][] }; closed?: boolean },
): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  const cs = sweep.crossSection.points;
  if (cs.length > 0) {
    shape.moveTo(cs[0][0], cs[0][1]);
    for (let i = 1; i < cs.length; i += 1) shape.lineTo(cs[i][0], cs[i][1]);
    shape.closePath();
  }
  const spine = sweep.spine.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const path = new THREE.CatmullRomCurve3(spine, sweep.closed ?? false);
  return new THREE.ExtrudeGeometry(shape, {
    extrudePath: path,
    steps: Math.max(24, spine.length * 8),
    bevelEnabled: false,
  });
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = (options.textureLoader ?? new THREE.TextureLoader()).load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Stylized ivory and brass double-door arch portal
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createStylizedIvoryAndBrassDoubleDoorArchPortalModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Stylized ivory and brass double-door arch portal";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 35, "aspect": 1.0795360397680198, "orientation": {"yaw": 0.12, "pitch": -0.04, "roll": 0}, "positionHint": [0, 2.2, 9.5], "note": "Approximate near-front8degree conceptual view; not camera-solved pixel projection."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["ivory"] = createSculptMaterial(
    "ivory",
    {"id": "ivory", "name": "ivory", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#e6d8bb", "color": "#e6d8bb", "albedo": {"dominant": "#E8DAC8", "secondary": ["#E6D8C6", "#EBDDCB", "#E3D4C3"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/assets/atmosphere/materials/production/ivory_albedo.png", "url": "/assets/atmosphere/materials/production/ivory_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#E8DAC8", "#E6D8C6", "#EBDDCB", "#E3D4C3", "#EDE0CD"], "pattern": "reference-derived pixel palette", "amplitude": 0.08, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.308, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.762, "variation": 0.149, "map": {"path": "/assets/atmosphere/materials/production/ivory_roughness.png", "url": "/assets/atmosphere/materials/production/ivory_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.05, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.244, "map": {"path": "/assets/atmosphere/materials/production/ivory_normal.png", "url": "/assets/atmosphere/materials/production/ivory_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/assets/atmosphere/materials/production/ivory_height.png", "url": "/assets/atmosphere/materials/production/ivory_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.034, "map": {"path": "/assets/atmosphere/materials/production/ivory_height.png", "url": "/assets/atmosphere/materials/production/ivory_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/assets/atmosphere/materials/production/ivory_ao.png", "url": "/assets/atmosphere/materials/production/ivory_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "ivory-edge-response", "region": "beveled edges", "roughness": 0.64, "evidenceRefs": ["full-object"]}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Stylized sampled palette with inferred roughness, not exact inverse-rendered PBR.", "referencePbr": {"version": "1.0", "sourceImage": "reference-evidence:ivory-clean-crop.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.716, "estimatedFidelity": 0.716, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/assets/atmosphere/materials/production/ivory_albedo.png", "url": "/assets/atmosphere/materials/production/ivory_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/assets/atmosphere/materials/production/ivory_roughness.png", "url": "/assets/atmosphere/materials/production/ivory_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/assets/atmosphere/materials/production/ivory_height.png", "url": "/assets/atmosphere/materials/production/ivory_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/assets/atmosphere/materials/production/ivory_normal.png", "url": "/assets/atmosphere/materials/production/ivory_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/assets/atmosphere/materials/production/ivory_ao.png", "url": "/assets/atmosphere/materials/production/ivory_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 50, "sourceHeight": 80, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 50, "height": 80}, "mask": {"backgroundColor": "#E8D9C8", "backgroundNoise": 6.557, "transparentPixelFraction": 0.0, "foregroundCoverage": 1.0}, "mapStats": {"valueRange": 0.08, "heightP90Gradient": 0.0752, "roughnessBase": 0.762, "roughnessVariation": 0.149, "normalStrength": 0.244, "blurRadius": 21}, "palette": ["#E8DAC8", "#E6D8C6", "#EBDDCB", "#E3D4C3", "#EDE0CD"]}, "warnings": ["foreground mask is tiny; material extraction is likely unreliable", "image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}, "finishClass": "plastic", "texturePalette": ["#E8DAC8", "#E8DAC7", "#E8DAC8", "#E7D9C7", "#E8DAC8"], "proceduralTexture": "flat-clearcoat", "clearcoat": {"base": 0.2, "variation": 0.0}, "clearcoatRoughness": {"base": 0.3, "variation": 0.0}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.5, "value": 1.5}, "envMapIntensity": 0.7},
    options
  );
  materialMap["brass"] = createSculptMaterial(
    "brass",
    {"id": "brass", "name": "brass", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#b29565", "color": "#b29565", "albedo": {"dominant": "#845C2C", "secondary": ["#865D2E", "#8D6333", "#896030"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/assets/atmosphere/materials/production/brass_albedo.png", "url": "/assets/atmosphere/materials/production/brass_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#845C2C", "#865D2E", "#8D6333", "#896030", "#80592A"], "pattern": "reference-derived pixel palette", "amplitude": 0.08, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.308, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.214, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.092, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.697, "variation": 0.05, "map": {"path": "/assets/atmosphere/materials/production/brass_roughness.png", "url": "/assets/atmosphere/materials/production/brass_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 1, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.174, "map": {"path": "/assets/atmosphere/materials/production/brass_normal.png", "url": "/assets/atmosphere/materials/production/brass_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/assets/atmosphere/materials/production/brass_height.png", "url": "/assets/atmosphere/materials/production/brass_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.01, "map": {"path": "/assets/atmosphere/materials/production/brass_height.png", "url": "/assets/atmosphere/materials/production/brass_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/assets/atmosphere/materials/production/brass_ao.png", "url": "/assets/atmosphere/materials/production/brass_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "brass-edge-response", "region": "beveled edges", "roughness": 0.24, "evidenceRefs": ["full-object"]}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Stylized sampled palette with inferred roughness, not exact inverse-rendered PBR.", "referencePbr": {"version": "1.0", "sourceImage": "reference-evidence:brass-crop.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.719, "estimatedFidelity": 0.719, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/assets/atmosphere/materials/production/brass_albedo.png", "url": "/assets/atmosphere/materials/production/brass_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/assets/atmosphere/materials/production/brass_roughness.png", "url": "/assets/atmosphere/materials/production/brass_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/assets/atmosphere/materials/production/brass_height.png", "url": "/assets/atmosphere/materials/production/brass_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/assets/atmosphere/materials/production/brass_normal.png", "url": "/assets/atmosphere/materials/production/brass_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/assets/atmosphere/materials/production/brass_ao.png", "url": "/assets/atmosphere/materials/production/brass_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 17, "sourceHeight": 240, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 17, "height": 240}, "mask": {"backgroundColor": "#88602F", "backgroundNoise": 7.28, "transparentPixelFraction": 0.0, "foregroundCoverage": 1.0}, "mapStats": {"valueRange": 0.08, "heightP90Gradient": 0.01534, "roughnessBase": 0.697, "roughnessVariation": 0.05, "normalStrength": 0.174, "blurRadius": 21}, "palette": ["#845C2C", "#865D2E", "#8D6333", "#896030", "#80592A"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}},
    options
  );
  materialMap["stone"] = createSculptMaterial(
    "stone",
    {"id": "stone", "name": "stone", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#d5c5a6", "color": "#d5c5a6", "albedo": {"dominant": "#C7B297", "secondary": ["#C1AA90", "#CDB89E", "#D3BEA5"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/assets/atmosphere/materials/production/stone_albedo.png", "url": "/assets/atmosphere/materials/production/stone_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#C7B297", "#C1AA90", "#CDB89E", "#D3BEA5", "#B79D7E"], "pattern": "reference-derived pixel palette", "amplitude": 0.08, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.315, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.729, "variation": 0.111, "map": {"path": "/assets/atmosphere/materials/production/stone_roughness.png", "url": "/assets/atmosphere/materials/production/stone_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.226, "map": {"path": "/assets/atmosphere/materials/production/stone_normal.png", "url": "/assets/atmosphere/materials/production/stone_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/assets/atmosphere/materials/production/stone_height.png", "url": "/assets/atmosphere/materials/production/stone_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.027, "map": {"path": "/assets/atmosphere/materials/production/stone_height.png", "url": "/assets/atmosphere/materials/production/stone_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/assets/atmosphere/materials/production/stone_ao.png", "url": "/assets/atmosphere/materials/production/stone_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "stone-edge-response", "region": "beveled edges", "roughness": 0.78, "evidenceRefs": ["full-object"]}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Stylized sampled palette with inferred roughness, not exact inverse-rendered PBR.", "referencePbr": {"version": "1.0", "sourceImage": "reference-evidence:stone-crop.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.751, "estimatedFidelity": 0.751, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/assets/atmosphere/materials/production/stone_albedo.png", "url": "/assets/atmosphere/materials/production/stone_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/assets/atmosphere/materials/production/stone_roughness.png", "url": "/assets/atmosphere/materials/production/stone_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/assets/atmosphere/materials/production/stone_height.png", "url": "/assets/atmosphere/materials/production/stone_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/assets/atmosphere/materials/production/stone_normal.png", "url": "/assets/atmosphere/materials/production/stone_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/assets/atmosphere/materials/production/stone_ao.png", "url": "/assets/atmosphere/materials/production/stone_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 240, "sourceHeight": 45, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 240, "height": 45}, "mask": {"backgroundColor": "#BFA88D", "backgroundNoise": 41.785, "transparentPixelFraction": 0.0, "foregroundCoverage": 1.0}, "mapStats": {"valueRange": 0.0987, "heightP90Gradient": 0.05977, "roughnessBase": 0.729, "roughnessVariation": 0.111, "normalStrength": 0.226, "blurRadius": 21}, "palette": ["#C7B297", "#C1AA90", "#CDB89E", "#D3BEA5", "#B79D7E"]}, "warnings": ["image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const attachment_root_0 = null;
  const endpoint_root_0 = makeAttachmentEndpoint(attachment_root_0);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "oval plinth__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "oval plinth", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 3.7, "height": 0.18, "depth": 1.8, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stone", "materialLayers": ["stone"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "plinth-rim", "kind": "bevel", "description": "Oval low plinth rim", "evidenceRefs": ["full-object"], "confidence": 0.85}, {"id": "stone-pores", "kind": "groove", "description": "Low amplitude stone-like base pores", "evidenceRefs": ["full-object"], "confidence": 0.85}], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["oval plinth observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(199, 178, 151, 1)", "secondaryAlbedo": "rgba(199, 178, 151, 1)", "materialClass": "stone", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(3.7, 0.18, 1.8);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["stone"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "oval plinth";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "oval plinth", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 3.7, "height": 0.18, "depth": 1.8, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stone", "materialLayers": ["stone"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "plinth-rim", "kind": "bevel", "description": "Oval low plinth rim", "evidenceRefs": ["full-object"], "confidence": 0.85}, {"id": "stone-pores", "kind": "groove", "description": "Low amplitude stone-like base pores", "evidenceRefs": ["full-object"], "confidence": 0.85}], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["oval plinth observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(199, 178, 151, 1)", "secondaryAlbedo": "rgba(199, 178, 151, 1)", "materialClass": "stone", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const endpoint_frame_1 = makeAttachmentEndpoint(null);
  const node_frame_1 = new THREE.Group();
  node_frame_1.name = "brass arch surround__pivot";
  node_frame_1.scale.set(1, 1, 1);
  if (endpoint_frame_1) {
    node_frame_1.position.copy(endpoint_frame_1.start);
    node_frame_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_frame_1.position.set(0.0, 0.09, -0.3);
    node_frame_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_frame_1.userData.sculptComponent = {"id": "frame", "name": "brass arch surround", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-1.4, 0], [1.4, 0], [1.4, 2.8], [1.4, 2.8], [1.3932586173410757, 2.937223996461385], [1.3730993925645225, 3.0731264508225795], [1.3397164700250923, 3.206398548156247], [1.2934313455158013, 3.3357568053111253], [1.234689770087697, 3.4599554315563967], [1.1640574572235634, 3.577798326227443], [1.0822146347078316, 3.6881505978291034], [0.9899494936611666, 3.789949493661166], [0.8881505978291037, 3.8822146347078315], [0.7777983262274432, 3.9640574572235634], [0.6599554315563969, 4.034689770087697], [0.5357568053111257, 4.093431345515802], [0.40639854815624726, 4.139716470025093], [0.27312645082257964, 4.173099392564522], [0.13722399646138506, 4.193258617341075], [8.572527594031472e-17, 4.199999999999999], [-0.1372239964613849, 4.193258617341075], [-0.27312645082257947, 4.173099392564522], [-0.406398548156247, 4.139716470025093], [-0.5357568053111256, 4.093431345515802], [-0.6599554315563967, 4.034689770087697], [-0.7777983262274427, 3.9640574572235634], [-0.8881505978291034, 3.8822146347078315], [-0.9899494936611664, 3.789949493661166], [-1.0822146347078316, 3.6881505978291034], [-1.1640574572235634, 3.577798326227443], [-1.2346897700876969, 3.4599554315563967], [-1.2934313455158013, 3.3357568053111257], [-1.3397164700250923, 3.206398548156247], [-1.3730993925645225, 3.07312645082258], [-1.3932586173410755, 2.937223996461385], [-1.4, 2.8], [-1.4, 0]], "holes": [[[-1.345, 0.03], [1.345, 0.03], [1.345, 2.8], [1.345, 2.8], [1.338523457374105, 2.931833053743259], [1.3191562021423449, 3.0623964831116925], [1.287084751559821, 3.1904328909072515], [1.2426179712276806, 3.3147092165310457], [1.1861841005485376, 3.434028611030967], [1.1183266285469233, 3.5472419634113646], [1.0396990597728812, 3.6532589672001032], [0.9510586206959065, 3.7510586206959062], [0.8532589672001032, 3.8396990597728813], [0.7472419634113651, 3.9183266285469234], [0.6340286110309671, 3.9861841005485372], [0.5147092165310458, 4.04261797122768], [0.3904328909072518, 4.0870847515598205], [0.2623964831116926, 4.119156202142345], [0.13183305374325924, 4.138523457374104], [8.23574972426595e-17, 4.145], [-0.13183305374325907, 4.138523457374105], [-0.2623964831116924, 4.119156202142345], [-0.3904328909072516, 4.0870847515598205], [-0.5147092165310456, 4.04261797122768], [-0.6340286110309669, 3.9861841005485372], [-0.7472419634113646, 3.9183266285469234], [-0.853258967200103, 3.8396990597728813], [-0.9510586206959063, 3.7510586206959062], [-1.0396990597728812, 3.6532589672001032], [-1.1183266285469236, 3.5472419634113646], [-1.1861841005485374, 3.434028611030967], [-1.2426179712276806, 3.3147092165310457], [-1.287084751559821, 3.190432890907252], [-1.3191562021423449, 3.0623964831116925], [-1.3385234573741047, 2.9318330537432593], [-1.345, 2.8], [-1.345, 0.03]]], "depth": 0.6}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-contact", "localStart": [0, 0.1, -0.035], "localEnd": [0, 1.1, -0.035], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.09, -0.3], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "brass", "materialLayers": ["brass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "arch-rim", "kind": "bevel", "description": "Thin bevel catches light around arch contour", "evidenceRefs": ["full-object"], "confidence": 0.85}, {"id": "brass-polish", "kind": "gloss", "description": "Low roughness narrow champagne brass trim", "evidenceRefs": ["full-object"], "confidence": 0.85}], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["brass arch surround observed in full-object", "Depth0.6 is an explicitly inferred sculptural architectural reveal to hold silhouette at side views, not observed exact hidden construction."], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(132, 92, 44, 1)", "secondaryAlbedo": "rgba(132, 92, 44, 1)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_frame_1.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_frame_1);
  nodes["frame"] = node_frame_1;
  const mesh_frame_1Geometry = endpoint_frame_1
    ? new THREE.CylinderGeometry(endpoint_frame_1.endRadius, endpoint_frame_1.baseRadius, endpoint_frame_1.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-1.4, 0], [1.4, 0], [1.4, 2.8], [1.4, 2.8], [1.3932586173410757, 2.937223996461385], [1.3730993925645225, 3.0731264508225795], [1.3397164700250923, 3.206398548156247], [1.2934313455158013, 3.3357568053111253], [1.234689770087697, 3.4599554315563967], [1.1640574572235634, 3.577798326227443], [1.0822146347078316, 3.6881505978291034], [0.9899494936611666, 3.789949493661166], [0.8881505978291037, 3.8822146347078315], [0.7777983262274432, 3.9640574572235634], [0.6599554315563969, 4.034689770087697], [0.5357568053111257, 4.093431345515802], [0.40639854815624726, 4.139716470025093], [0.27312645082257964, 4.173099392564522], [0.13722399646138506, 4.193258617341075], [8.572527594031472e-17, 4.199999999999999], [-0.1372239964613849, 4.193258617341075], [-0.27312645082257947, 4.173099392564522], [-0.406398548156247, 4.139716470025093], [-0.5357568053111256, 4.093431345515802], [-0.6599554315563967, 4.034689770087697], [-0.7777983262274427, 3.9640574572235634], [-0.8881505978291034, 3.8822146347078315], [-0.9899494936611664, 3.789949493661166], [-1.0822146347078316, 3.6881505978291034], [-1.1640574572235634, 3.577798326227443], [-1.2346897700876969, 3.4599554315563967], [-1.2934313455158013, 3.3357568053111257], [-1.3397164700250923, 3.206398548156247], [-1.3730993925645225, 3.07312645082258], [-1.3932586173410755, 2.937223996461385], [-1.4, 2.8], [-1.4, 0]], "holes": [[[-1.345, 0.03], [1.345, 0.03], [1.345, 2.8], [1.345, 2.8], [1.338523457374105, 2.931833053743259], [1.3191562021423449, 3.0623964831116925], [1.287084751559821, 3.1904328909072515], [1.2426179712276806, 3.3147092165310457], [1.1861841005485376, 3.434028611030967], [1.1183266285469233, 3.5472419634113646], [1.0396990597728812, 3.6532589672001032], [0.9510586206959065, 3.7510586206959062], [0.8532589672001032, 3.8396990597728813], [0.7472419634113651, 3.9183266285469234], [0.6340286110309671, 3.9861841005485372], [0.5147092165310458, 4.04261797122768], [0.3904328909072518, 4.0870847515598205], [0.2623964831116926, 4.119156202142345], [0.13183305374325924, 4.138523457374104], [8.23574972426595e-17, 4.145], [-0.13183305374325907, 4.138523457374105], [-0.2623964831116924, 4.119156202142345], [-0.3904328909072516, 4.0870847515598205], [-0.5147092165310456, 4.04261797122768], [-0.6340286110309669, 3.9861841005485372], [-0.7472419634113646, 3.9183266285469234], [-0.853258967200103, 3.8396990597728813], [-0.9510586206959063, 3.7510586206959062], [-1.0396990597728812, 3.6532589672001032], [-1.1183266285469236, 3.5472419634113646], [-1.1861841005485374, 3.434028611030967], [-1.2426179712276806, 3.3147092165310457], [-1.287084751559821, 3.190432890907252], [-1.3191562021423449, 3.0623964831116925], [-1.3385234573741047, 2.9318330537432593], [-1.345, 2.8], [-1.345, 0.03]]], "depth": 0.6});
  if (!endpoint_frame_1) {
    mesh_frame_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_frame_1 = new THREE.Mesh(
    mesh_frame_1Geometry,
    materialMap["brass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_frame_1.name = "brass arch surround";
  if (endpoint_frame_1) {
    mesh_frame_1.position.copy(endpoint_frame_1.midpoint);
    mesh_frame_1.quaternion.copy(endpoint_frame_1.quaternion);
  }
  mesh_frame_1.castShadow = options.castShadow ?? true;
  mesh_frame_1.receiveShadow = options.receiveShadow ?? true;
  mesh_frame_1.userData.sculptComponent = {"id": "frame", "name": "brass arch surround", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-1.4, 0], [1.4, 0], [1.4, 2.8], [1.4, 2.8], [1.3932586173410757, 2.937223996461385], [1.3730993925645225, 3.0731264508225795], [1.3397164700250923, 3.206398548156247], [1.2934313455158013, 3.3357568053111253], [1.234689770087697, 3.4599554315563967], [1.1640574572235634, 3.577798326227443], [1.0822146347078316, 3.6881505978291034], [0.9899494936611666, 3.789949493661166], [0.8881505978291037, 3.8822146347078315], [0.7777983262274432, 3.9640574572235634], [0.6599554315563969, 4.034689770087697], [0.5357568053111257, 4.093431345515802], [0.40639854815624726, 4.139716470025093], [0.27312645082257964, 4.173099392564522], [0.13722399646138506, 4.193258617341075], [8.572527594031472e-17, 4.199999999999999], [-0.1372239964613849, 4.193258617341075], [-0.27312645082257947, 4.173099392564522], [-0.406398548156247, 4.139716470025093], [-0.5357568053111256, 4.093431345515802], [-0.6599554315563967, 4.034689770087697], [-0.7777983262274427, 3.9640574572235634], [-0.8881505978291034, 3.8822146347078315], [-0.9899494936611664, 3.789949493661166], [-1.0822146347078316, 3.6881505978291034], [-1.1640574572235634, 3.577798326227443], [-1.2346897700876969, 3.4599554315563967], [-1.2934313455158013, 3.3357568053111257], [-1.3397164700250923, 3.206398548156247], [-1.3730993925645225, 3.07312645082258], [-1.3932586173410755, 2.937223996461385], [-1.4, 2.8], [-1.4, 0]], "holes": [[[-1.345, 0.03], [1.345, 0.03], [1.345, 2.8], [1.345, 2.8], [1.338523457374105, 2.931833053743259], [1.3191562021423449, 3.0623964831116925], [1.287084751559821, 3.1904328909072515], [1.2426179712276806, 3.3147092165310457], [1.1861841005485376, 3.434028611030967], [1.1183266285469233, 3.5472419634113646], [1.0396990597728812, 3.6532589672001032], [0.9510586206959065, 3.7510586206959062], [0.8532589672001032, 3.8396990597728813], [0.7472419634113651, 3.9183266285469234], [0.6340286110309671, 3.9861841005485372], [0.5147092165310458, 4.04261797122768], [0.3904328909072518, 4.0870847515598205], [0.2623964831116926, 4.119156202142345], [0.13183305374325924, 4.138523457374104], [8.23574972426595e-17, 4.145], [-0.13183305374325907, 4.138523457374105], [-0.2623964831116924, 4.119156202142345], [-0.3904328909072516, 4.0870847515598205], [-0.5147092165310456, 4.04261797122768], [-0.6340286110309669, 3.9861841005485372], [-0.7472419634113646, 3.9183266285469234], [-0.853258967200103, 3.8396990597728813], [-0.9510586206959063, 3.7510586206959062], [-1.0396990597728812, 3.6532589672001032], [-1.1183266285469236, 3.5472419634113646], [-1.1861841005485374, 3.434028611030967], [-1.2426179712276806, 3.3147092165310457], [-1.287084751559821, 3.190432890907252], [-1.3191562021423449, 3.0623964831116925], [-1.3385234573741047, 2.9318330537432593], [-1.345, 2.8], [-1.345, 0.03]]], "depth": 0.6}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-contact", "localStart": [0, 0.1, -0.035], "localEnd": [0, 1.1, -0.035], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.09, -0.3], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "frame", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "brass", "materialLayers": ["brass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "arch-rim", "kind": "bevel", "description": "Thin bevel catches light around arch contour", "evidenceRefs": ["full-object"], "confidence": 0.85}, {"id": "brass-polish", "kind": "gloss", "description": "Low roughness narrow champagne brass trim", "evidenceRefs": ["full-object"], "confidence": 0.85}], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["brass arch surround observed in full-object", "Depth0.6 is an explicitly inferred sculptural architectural reveal to hold silhouette at side views, not observed exact hidden construction."], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(132, 92, 44, 1)", "secondaryAlbedo": "rgba(132, 92, 44, 1)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_frame_1.add(mesh_frame_1);
  meshes["frame"] = mesh_frame_1;
  colliders["frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["frame"] ??= [];
  destructionGroups["frame"].push(node_frame_1);

  const endpoint_leftDoor_2 = makeAttachmentEndpoint(null);
  const node_leftDoor_2 = new THREE.Group();
  node_leftDoor_2.name = "left hinged ivory leaf__pivot";
  node_leftDoor_2.scale.set(1, 1, 1);
  if (endpoint_leftDoor_2) {
    node_leftDoor_2.position.copy(endpoint_leftDoor_2.start);
    node_leftDoor_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leftDoor_2.position.set(-1.408, 0.09, 0.0);
    node_leftDoor_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_leftDoor_2.userData.sculptComponent = {"id": "leftDoor", "name": "left hinged ivory leaf", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [1.4, 0], [1.4, 4.199999999999999], [1.4, 4.199999999999999], [1.3313052559416148, 4.198313638687241], [1.262776003538615, 4.193258617341075], [1.1945773357624936, 4.184847113950693], [1.1268735491774204, 4.173099392564522], [1.0598277481354306, 4.158043754472361], [0.9936014518437529, 4.139716470025093], [0.928354205250892, 4.118161691256229], [0.8642431946888743, 4.093431345515802], [0.8014228691976053, 4.06558501037282], [0.7400445684436032, 4.034689770087697], [0.6802561581294896, 4.00082005400038], [0.6222016737725572, 3.9640574572235634], [0.5660209737105932, 3.9244905440729028], [0.5118494021708965, 3.8822146347078315], [0.45981746321417416, 3.8373315754969424], [0.41005050633883355, 3.789949493661166], [0.3626684245030576, 3.7401825367858255], [0.3177853652921683, 3.6881505978291034], [0.2755094559270972, 3.6339790262894067], [0.23594254277643656, 3.577798326227443], [0.19917994599961908, 3.5197438418705103], [0.16531022991230304, 3.4599554315563967], [0.13441498962717957, 3.398577130802395], [0.10656865448419861, 3.3357568053111257], [0.08183830874377085, 3.2716457947491078], [0.0602835299749076, 3.206398548156247], [0.041956245527638325, 3.1401722518645694], [0.026900607435477397, 3.07312645082258], [0.015152886049306646, 3.005422664237506], [0.006741382658924433, 2.937223996461385], [0.0016863613127586774, 2.8686947440583848], [0.0, 2.8], [0, 0]], "depth": 0.075}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-contact", "localStart": [-1.4, 0.12, 0], "localEnd": [-1.4, 1.12, 0], "contactType": "hinge", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-1.408, 0.09, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "hinged-panel", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftDoor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "central-seam", "kind": "seam", "description": "Narrow true gap between two closed leaves", "evidenceRefs": ["full-object"], "confidence": 0.85}, {"id": "ivory-grain", "kind": "ridge", "description": "Fine plaster-like panel grain, not baked illumination", "evidenceRefs": ["full-object"], "confidence": 0.85}], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left hinged ivory leaf observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leftDoor_2.userData.actionProfile = {"animationRole": "hinged-panel", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftDoor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_leftDoor_2);
  nodes["leftDoor"] = node_leftDoor_2;
  const mesh_leftDoor_2Geometry = endpoint_leftDoor_2
    ? new THREE.CylinderGeometry(endpoint_leftDoor_2.endRadius, endpoint_leftDoor_2.baseRadius, endpoint_leftDoor_2.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0, 0], [1.4, 0], [1.4, 4.199999999999999], [1.4, 4.199999999999999], [1.3313052559416148, 4.198313638687241], [1.262776003538615, 4.193258617341075], [1.1945773357624936, 4.184847113950693], [1.1268735491774204, 4.173099392564522], [1.0598277481354306, 4.158043754472361], [0.9936014518437529, 4.139716470025093], [0.928354205250892, 4.118161691256229], [0.8642431946888743, 4.093431345515802], [0.8014228691976053, 4.06558501037282], [0.7400445684436032, 4.034689770087697], [0.6802561581294896, 4.00082005400038], [0.6222016737725572, 3.9640574572235634], [0.5660209737105932, 3.9244905440729028], [0.5118494021708965, 3.8822146347078315], [0.45981746321417416, 3.8373315754969424], [0.41005050633883355, 3.789949493661166], [0.3626684245030576, 3.7401825367858255], [0.3177853652921683, 3.6881505978291034], [0.2755094559270972, 3.6339790262894067], [0.23594254277643656, 3.577798326227443], [0.19917994599961908, 3.5197438418705103], [0.16531022991230304, 3.4599554315563967], [0.13441498962717957, 3.398577130802395], [0.10656865448419861, 3.3357568053111257], [0.08183830874377085, 3.2716457947491078], [0.0602835299749076, 3.206398548156247], [0.041956245527638325, 3.1401722518645694], [0.026900607435477397, 3.07312645082258], [0.015152886049306646, 3.005422664237506], [0.006741382658924433, 2.937223996461385], [0.0016863613127586774, 2.8686947440583848], [0.0, 2.8], [0, 0]], "depth": 0.075});
  if (!endpoint_leftDoor_2) {
    mesh_leftDoor_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leftDoor_2 = new THREE.Mesh(
    mesh_leftDoor_2Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leftDoor_2.name = "left hinged ivory leaf";
  if (endpoint_leftDoor_2) {
    mesh_leftDoor_2.position.copy(endpoint_leftDoor_2.midpoint);
    mesh_leftDoor_2.quaternion.copy(endpoint_leftDoor_2.quaternion);
  }
  mesh_leftDoor_2.castShadow = options.castShadow ?? true;
  mesh_leftDoor_2.receiveShadow = options.receiveShadow ?? true;
  mesh_leftDoor_2.userData.sculptComponent = {"id": "leftDoor", "name": "left hinged ivory leaf", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [1.4, 0], [1.4, 4.199999999999999], [1.4, 4.199999999999999], [1.3313052559416148, 4.198313638687241], [1.262776003538615, 4.193258617341075], [1.1945773357624936, 4.184847113950693], [1.1268735491774204, 4.173099392564522], [1.0598277481354306, 4.158043754472361], [0.9936014518437529, 4.139716470025093], [0.928354205250892, 4.118161691256229], [0.8642431946888743, 4.093431345515802], [0.8014228691976053, 4.06558501037282], [0.7400445684436032, 4.034689770087697], [0.6802561581294896, 4.00082005400038], [0.6222016737725572, 3.9640574572235634], [0.5660209737105932, 3.9244905440729028], [0.5118494021708965, 3.8822146347078315], [0.45981746321417416, 3.8373315754969424], [0.41005050633883355, 3.789949493661166], [0.3626684245030576, 3.7401825367858255], [0.3177853652921683, 3.6881505978291034], [0.2755094559270972, 3.6339790262894067], [0.23594254277643656, 3.577798326227443], [0.19917994599961908, 3.5197438418705103], [0.16531022991230304, 3.4599554315563967], [0.13441498962717957, 3.398577130802395], [0.10656865448419861, 3.3357568053111257], [0.08183830874377085, 3.2716457947491078], [0.0602835299749076, 3.206398548156247], [0.041956245527638325, 3.1401722518645694], [0.026900607435477397, 3.07312645082258], [0.015152886049306646, 3.005422664237506], [0.006741382658924433, 2.937223996461385], [0.0016863613127586774, 2.8686947440583848], [0.0, 2.8], [0, 0]], "depth": 0.075}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-contact", "localStart": [-1.4, 0.12, 0], "localEnd": [-1.4, 1.12, 0], "contactType": "hinge", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-1.408, 0.09, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "hinged-panel", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftDoor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "central-seam", "kind": "seam", "description": "Narrow true gap between two closed leaves", "evidenceRefs": ["full-object"], "confidence": 0.85}, {"id": "ivory-grain", "kind": "ridge", "description": "Fine plaster-like panel grain, not baked illumination", "evidenceRefs": ["full-object"], "confidence": 0.85}], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left hinged ivory leaf observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leftDoor_2.add(mesh_leftDoor_2);
  meshes["leftDoor"] = mesh_leftDoor_2;
  colliders["leftDoor"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["leftDoor"] ??= [];
  destructionGroups["leftDoor"].push(node_leftDoor_2);

  const attachment_hingeA_3 = {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [-0.012, 0.58, 0.045], "localEnd": [-0.012, 0.83, 0.045], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]};
  const endpoint_hingeA_3 = makeAttachmentEndpoint(attachment_hingeA_3);
  const node_hingeA_3 = new THREE.Group();
  node_hingeA_3.name = "left brass hinge barrel 0__pivot";
  node_hingeA_3.scale.set(1, 1, 1);
  if (endpoint_hingeA_3) {
    node_hingeA_3.position.copy(endpoint_hingeA_3.start);
    node_hingeA_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_hingeA_3.position.set(-0.012, 0.58, 0.045);
    node_hingeA_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_hingeA_3.userData.sculptComponent = {"id": "hingeA", "name": "left brass hinge barrel 0", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [-0.012, 0.58, 0.045], "localEnd": [-0.012, 0.83, 0.045], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1, "height": 0.25, "depth": 0.1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.012, 0.58, 0.045], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hingeA", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "brass", "materialLayers": ["brass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "hinge-barrels", "kind": "fastener", "description": "Four cylindrical hinge barrels at lateral jambs", "evidenceRefs": ["full-object"], "confidence": 0.85}], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left brass hinge barrel 0 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(132, 92, 44, 1)", "secondaryAlbedo": "rgba(132, 92, 44, 1)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_hingeA_3.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hingeA", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["leftDoor"] ?? root).add(node_hingeA_3);
  nodes["hingeA"] = node_hingeA_3;
  const mesh_hingeA_3Geometry = endpoint_hingeA_3
    ? new THREE.CylinderGeometry(endpoint_hingeA_3.endRadius, endpoint_hingeA_3.baseRadius, endpoint_hingeA_3.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_hingeA_3) {
    mesh_hingeA_3Geometry.scale(0.1, 0.25, 0.1);
  }
  const mesh_hingeA_3 = new THREE.Mesh(
    mesh_hingeA_3Geometry,
    materialMap["brass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hingeA_3.name = "left brass hinge barrel 0";
  if (endpoint_hingeA_3) {
    mesh_hingeA_3.position.copy(endpoint_hingeA_3.midpoint);
    mesh_hingeA_3.quaternion.copy(endpoint_hingeA_3.quaternion);
  }
  mesh_hingeA_3.castShadow = options.castShadow ?? true;
  mesh_hingeA_3.receiveShadow = options.receiveShadow ?? true;
  mesh_hingeA_3.userData.sculptComponent = {"id": "hingeA", "name": "left brass hinge barrel 0", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [-0.012, 0.58, 0.045], "localEnd": [-0.012, 0.83, 0.045], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1, "height": 0.25, "depth": 0.1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.012, 0.58, 0.045], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "hingeA", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "brass", "materialLayers": ["brass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "hinge-barrels", "kind": "fastener", "description": "Four cylindrical hinge barrels at lateral jambs", "evidenceRefs": ["full-object"], "confidence": 0.85}], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left brass hinge barrel 0 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(132, 92, 44, 1)", "secondaryAlbedo": "rgba(132, 92, 44, 1)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_hingeA_3.add(mesh_hingeA_3);
  meshes["hingeA"] = mesh_hingeA_3;
  colliders["hingeA"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["hingeA"] ??= [];
  destructionGroups["hingeA"].push(node_hingeA_3);

  const attachment_leftHinge1_4 = {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [-0.012, 2.98, 0.045], "localEnd": [-0.012, 3.23, 0.045], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]};
  const endpoint_leftHinge1_4 = makeAttachmentEndpoint(attachment_leftHinge1_4);
  const node_leftHinge1_4 = new THREE.Group();
  node_leftHinge1_4.name = "left brass hinge barrel 1__pivot";
  node_leftHinge1_4.scale.set(1, 1, 1);
  if (endpoint_leftHinge1_4) {
    node_leftHinge1_4.position.copy(endpoint_leftHinge1_4.start);
    node_leftHinge1_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leftHinge1_4.position.set(-0.012, 2.98, 0.045);
    node_leftHinge1_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_leftHinge1_4.userData.sculptComponent = {"id": "leftHinge1", "name": "left brass hinge barrel 1", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [-0.012, 2.98, 0.045], "localEnd": [-0.012, 3.23, 0.045], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1, "height": 0.25, "depth": 0.1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.012, 2.98, 0.045], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftHinge1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "brass", "materialLayers": ["brass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left brass hinge barrel 1 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(132, 92, 44, 1)", "secondaryAlbedo": "rgba(132, 92, 44, 1)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leftHinge1_4.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftHinge1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["leftDoor"] ?? root).add(node_leftHinge1_4);
  nodes["leftHinge1"] = node_leftHinge1_4;
  const mesh_leftHinge1_4Geometry = endpoint_leftHinge1_4
    ? new THREE.CylinderGeometry(endpoint_leftHinge1_4.endRadius, endpoint_leftHinge1_4.baseRadius, endpoint_leftHinge1_4.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_leftHinge1_4) {
    mesh_leftHinge1_4Geometry.scale(0.1, 0.25, 0.1);
  }
  const mesh_leftHinge1_4 = new THREE.Mesh(
    mesh_leftHinge1_4Geometry,
    materialMap["brass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leftHinge1_4.name = "left brass hinge barrel 1";
  if (endpoint_leftHinge1_4) {
    mesh_leftHinge1_4.position.copy(endpoint_leftHinge1_4.midpoint);
    mesh_leftHinge1_4.quaternion.copy(endpoint_leftHinge1_4.quaternion);
  }
  mesh_leftHinge1_4.castShadow = options.castShadow ?? true;
  mesh_leftHinge1_4.receiveShadow = options.receiveShadow ?? true;
  mesh_leftHinge1_4.userData.sculptComponent = {"id": "leftHinge1", "name": "left brass hinge barrel 1", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [-0.012, 2.98, 0.045], "localEnd": [-0.012, 3.23, 0.045], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1, "height": 0.25, "depth": 0.1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.012, 2.98, 0.045], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftHinge1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "brass", "materialLayers": ["brass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left brass hinge barrel 1 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(132, 92, 44, 1)", "secondaryAlbedo": "rgba(132, 92, 44, 1)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leftHinge1_4.add(mesh_leftHinge1_4);
  meshes["leftHinge1"] = mesh_leftHinge1_4;
  colliders["leftHinge1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["leftHinge1"] ??= [];
  destructionGroups["leftHinge1"].push(node_leftHinge1_4);

  const attachment_leftStem_5 = {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [0, 0, 0], "localEnd": [0, 1, 0], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]};
  const endpoint_leftStem_5 = makeAttachmentEndpoint(null);
  const node_leftStem_5 = new THREE.Group();
  node_leftStem_5.name = "left raised botanical stem__pivot";
  node_leftStem_5.scale.set(1, 1, 1);
  if (endpoint_leftStem_5) {
    node_leftStem_5.position.copy(endpoint_leftStem_5.start);
    node_leftStem_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leftStem_5.position.set(0.0, 0.0, 0.0);
    node_leftStem_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_leftStem_5.userData.sculptComponent = {"id": "leftStem", "name": "left raised botanical stem", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "curve-sweep", "topologyClass": "fiber-strand", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "curveSweep": {"spine": [[0.32, 0.15, 0.08], [0.75, 0.8, 0.08], [0.55, 1.6, 0.08], [0.92, 2.4, 0.08], [0.68, 3.5, 0.08]], "crossSection": {"points": [[0.012, 0.0], [0.008485281374238571, 0.00848528137423857], [7.347880794884119e-19, 0.012], [-0.00848528137423857, 0.008485281374238571], [-0.012, 1.4695761589768239e-18], [-0.008485281374238573, -0.00848528137423857], [-2.2043642384652355e-18, -0.012], [0.008485281374238568, -0.008485281374238573]]}, "closed": false}}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [0, 0, 0], "localEnd": [0, 1, 0], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftStem", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "brass", "materialLayers": ["brass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "stem-relief", "kind": "ridge", "description": "Raised curved botanical stem", "evidenceRefs": ["full-object"], "confidence": 0.85}], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left raised botanical stem observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(132, 92, 44, 1)", "secondaryAlbedo": "rgba(132, 92, 44, 1)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leftStem_5.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftStem", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["leftDoor"] ?? root).add(node_leftStem_5);
  nodes["leftStem"] = node_leftStem_5;
  const mesh_leftStem_5Geometry = endpoint_leftStem_5
    ? new THREE.CylinderGeometry(endpoint_leftStem_5.endRadius, endpoint_leftStem_5.baseRadius, endpoint_leftStem_5.length, 16, 6)
    : buildCurveSweepGeometry({"spine": [[0.32, 0.15, 0.08], [0.75, 0.8, 0.08], [0.55, 1.6, 0.08], [0.92, 2.4, 0.08], [0.68, 3.5, 0.08]], "crossSection": {"points": [[0.012, 0.0], [0.008485281374238571, 0.00848528137423857], [7.347880794884119e-19, 0.012], [-0.00848528137423857, 0.008485281374238571], [-0.012, 1.4695761589768239e-18], [-0.008485281374238573, -0.00848528137423857], [-2.2043642384652355e-18, -0.012], [0.008485281374238568, -0.008485281374238573]]}, "closed": false});
  if (!endpoint_leftStem_5) {
    mesh_leftStem_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leftStem_5 = new THREE.Mesh(
    mesh_leftStem_5Geometry,
    materialMap["brass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leftStem_5.name = "left raised botanical stem";
  if (endpoint_leftStem_5) {
    mesh_leftStem_5.position.copy(endpoint_leftStem_5.midpoint);
    mesh_leftStem_5.quaternion.copy(endpoint_leftStem_5.quaternion);
  }
  mesh_leftStem_5.castShadow = options.castShadow ?? true;
  mesh_leftStem_5.receiveShadow = options.receiveShadow ?? true;
  mesh_leftStem_5.userData.sculptComponent = {"id": "leftStem", "name": "left raised botanical stem", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "curve-sweep", "topologyClass": "fiber-strand", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "curveSweep": {"spine": [[0.32, 0.15, 0.08], [0.75, 0.8, 0.08], [0.55, 1.6, 0.08], [0.92, 2.4, 0.08], [0.68, 3.5, 0.08]], "crossSection": {"points": [[0.012, 0.0], [0.008485281374238571, 0.00848528137423857], [7.347880794884119e-19, 0.012], [-0.00848528137423857, 0.008485281374238571], [-0.012, 1.4695761589768239e-18], [-0.008485281374238573, -0.00848528137423857], [-2.2043642384652355e-18, -0.012], [0.008485281374238568, -0.008485281374238573]]}, "closed": false}}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [0, 0, 0], "localEnd": [0, 1, 0], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftStem", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "brass", "materialLayers": ["brass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "stem-relief", "kind": "ridge", "description": "Raised curved botanical stem", "evidenceRefs": ["full-object"], "confidence": 0.85}], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left raised botanical stem observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(132, 92, 44, 1)", "secondaryAlbedo": "rgba(132, 92, 44, 1)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leftStem_5.add(mesh_leftStem_5);
  meshes["leftStem"] = mesh_leftStem_5;
  colliders["leftStem"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["leftStem"] ??= [];
  destructionGroups["leftStem"].push(node_leftStem_5);

  const endpoint_leafA_6 = makeAttachmentEndpoint(null);
  const node_leafA_6 = new THREE.Group();
  node_leafA_6.name = "left ivory botanical leaf 0__pivot";
  node_leafA_6.scale.set(1, 1, 1);
  if (endpoint_leafA_6) {
    node_leafA_6.position.copy(endpoint_leafA_6.start);
    node_leafA_6.rotation.set(0.0, 0.0, 0.6);
  } else {
    node_leafA_6.position.set(0.42, 0.55, 0.066);
    node_leafA_6.rotation.set(0.0, 0.0, 0.6);
  }
  node_leafA_6.userData.sculptComponent = {"id": "leafA", "name": "left ivory botanical leaf 0", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [0.42, 0.55, 0.085], "localEnd": [0.42, 1.55, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.42, 0.55, 0.066], "rotation": [0, 0, 0.6]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leafA", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "leaf-relief", "kind": "ridge", "description": "Pointed leaf relief with shallow volume", "evidenceRefs": ["full-object"], "confidence": 0.85}], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left ivory botanical leaf 0 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leafA_6.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leafA", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["leftDoor"] ?? root).add(node_leafA_6);
  nodes["leafA"] = node_leafA_6;
  const mesh_leafA_6Geometry = endpoint_leafA_6
    ? new THREE.CylinderGeometry(endpoint_leafA_6.endRadius, endpoint_leafA_6.baseRadius, endpoint_leafA_6.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028});
  if (!endpoint_leafA_6) {
    mesh_leafA_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leafA_6 = new THREE.Mesh(
    mesh_leafA_6Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leafA_6.name = "left ivory botanical leaf 0";
  if (endpoint_leafA_6) {
    mesh_leafA_6.position.copy(endpoint_leafA_6.midpoint);
    mesh_leafA_6.quaternion.copy(endpoint_leafA_6.quaternion);
  }
  mesh_leafA_6.castShadow = options.castShadow ?? true;
  mesh_leafA_6.receiveShadow = options.receiveShadow ?? true;
  mesh_leafA_6.userData.sculptComponent = {"id": "leafA", "name": "left ivory botanical leaf 0", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [0.42, 0.55, 0.085], "localEnd": [0.42, 1.55, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.42, 0.55, 0.066], "rotation": [0, 0, 0.6]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leafA", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "leaf-relief", "kind": "ridge", "description": "Pointed leaf relief with shallow volume", "evidenceRefs": ["full-object"], "confidence": 0.85}], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left ivory botanical leaf 0 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leafA_6.add(mesh_leafA_6);
  meshes["leafA"] = mesh_leafA_6;
  colliders["leafA"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["leafA"] ??= [];
  destructionGroups["leafA"].push(node_leafA_6);

  const endpoint_leftLeaf1_7 = makeAttachmentEndpoint(null);
  const node_leftLeaf1_7 = new THREE.Group();
  node_leftLeaf1_7.name = "left ivory botanical leaf 1__pivot";
  node_leftLeaf1_7.scale.set(1, 1, 1);
  if (endpoint_leftLeaf1_7) {
    node_leftLeaf1_7.position.copy(endpoint_leftLeaf1_7.start);
    node_leftLeaf1_7.rotation.set(0.0, 0.0, -0.5);
  } else {
    node_leftLeaf1_7.position.set(0.72, 0.85, 0.066);
    node_leftLeaf1_7.rotation.set(0.0, 0.0, -0.5);
  }
  node_leftLeaf1_7.userData.sculptComponent = {"id": "leftLeaf1", "name": "left ivory botanical leaf 1", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [0.72, 0.85, 0.085], "localEnd": [0.72, 1.85, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.72, 0.85, 0.066], "rotation": [0, 0, -0.5]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftLeaf1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left ivory botanical leaf 1 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leftLeaf1_7.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftLeaf1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["leftDoor"] ?? root).add(node_leftLeaf1_7);
  nodes["leftLeaf1"] = node_leftLeaf1_7;
  const mesh_leftLeaf1_7Geometry = endpoint_leftLeaf1_7
    ? new THREE.CylinderGeometry(endpoint_leftLeaf1_7.endRadius, endpoint_leftLeaf1_7.baseRadius, endpoint_leftLeaf1_7.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028});
  if (!endpoint_leftLeaf1_7) {
    mesh_leftLeaf1_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leftLeaf1_7 = new THREE.Mesh(
    mesh_leftLeaf1_7Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leftLeaf1_7.name = "left ivory botanical leaf 1";
  if (endpoint_leftLeaf1_7) {
    mesh_leftLeaf1_7.position.copy(endpoint_leftLeaf1_7.midpoint);
    mesh_leftLeaf1_7.quaternion.copy(endpoint_leftLeaf1_7.quaternion);
  }
  mesh_leftLeaf1_7.castShadow = options.castShadow ?? true;
  mesh_leftLeaf1_7.receiveShadow = options.receiveShadow ?? true;
  mesh_leftLeaf1_7.userData.sculptComponent = {"id": "leftLeaf1", "name": "left ivory botanical leaf 1", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [0.72, 0.85, 0.085], "localEnd": [0.72, 1.85, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.72, 0.85, 0.066], "rotation": [0, 0, -0.5]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftLeaf1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left ivory botanical leaf 1 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leftLeaf1_7.add(mesh_leftLeaf1_7);
  meshes["leftLeaf1"] = mesh_leftLeaf1_7;
  colliders["leftLeaf1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["leftLeaf1"] ??= [];
  destructionGroups["leftLeaf1"].push(node_leftLeaf1_7);

  const endpoint_leftLeaf2_8 = makeAttachmentEndpoint(null);
  const node_leftLeaf2_8 = new THREE.Group();
  node_leftLeaf2_8.name = "left ivory botanical leaf 2__pivot";
  node_leftLeaf2_8.scale.set(1, 1, 1);
  if (endpoint_leftLeaf2_8) {
    node_leftLeaf2_8.position.copy(endpoint_leftLeaf2_8.start);
    node_leftLeaf2_8.rotation.set(0.0, 0.0, 0.7);
  } else {
    node_leftLeaf2_8.position.set(0.54, 1.3, 0.066);
    node_leftLeaf2_8.rotation.set(0.0, 0.0, 0.7);
  }
  node_leftLeaf2_8.userData.sculptComponent = {"id": "leftLeaf2", "name": "left ivory botanical leaf 2", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [0.54, 1.3, 0.085], "localEnd": [0.54, 2.3, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.54, 1.3, 0.066], "rotation": [0, 0, 0.7]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftLeaf2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left ivory botanical leaf 2 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leftLeaf2_8.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftLeaf2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["leftDoor"] ?? root).add(node_leftLeaf2_8);
  nodes["leftLeaf2"] = node_leftLeaf2_8;
  const mesh_leftLeaf2_8Geometry = endpoint_leftLeaf2_8
    ? new THREE.CylinderGeometry(endpoint_leftLeaf2_8.endRadius, endpoint_leftLeaf2_8.baseRadius, endpoint_leftLeaf2_8.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028});
  if (!endpoint_leftLeaf2_8) {
    mesh_leftLeaf2_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leftLeaf2_8 = new THREE.Mesh(
    mesh_leftLeaf2_8Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leftLeaf2_8.name = "left ivory botanical leaf 2";
  if (endpoint_leftLeaf2_8) {
    mesh_leftLeaf2_8.position.copy(endpoint_leftLeaf2_8.midpoint);
    mesh_leftLeaf2_8.quaternion.copy(endpoint_leftLeaf2_8.quaternion);
  }
  mesh_leftLeaf2_8.castShadow = options.castShadow ?? true;
  mesh_leftLeaf2_8.receiveShadow = options.receiveShadow ?? true;
  mesh_leftLeaf2_8.userData.sculptComponent = {"id": "leftLeaf2", "name": "left ivory botanical leaf 2", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [0.54, 1.3, 0.085], "localEnd": [0.54, 2.3, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.54, 1.3, 0.066], "rotation": [0, 0, 0.7]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftLeaf2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left ivory botanical leaf 2 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leftLeaf2_8.add(mesh_leftLeaf2_8);
  meshes["leftLeaf2"] = mesh_leftLeaf2_8;
  colliders["leftLeaf2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["leftLeaf2"] ??= [];
  destructionGroups["leftLeaf2"].push(node_leftLeaf2_8);

  const endpoint_leftLeaf3_9 = makeAttachmentEndpoint(null);
  const node_leftLeaf3_9 = new THREE.Group();
  node_leftLeaf3_9.name = "left ivory botanical leaf 3__pivot";
  node_leftLeaf3_9.scale.set(1, 1, 1);
  if (endpoint_leftLeaf3_9) {
    node_leftLeaf3_9.position.copy(endpoint_leftLeaf3_9.start);
    node_leftLeaf3_9.rotation.set(0.0, 0.0, -0.45);
  } else {
    node_leftLeaf3_9.position.set(0.94, 1.64, 0.066);
    node_leftLeaf3_9.rotation.set(0.0, 0.0, -0.45);
  }
  node_leftLeaf3_9.userData.sculptComponent = {"id": "leftLeaf3", "name": "left ivory botanical leaf 3", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [0.94, 1.64, 0.085], "localEnd": [0.94, 2.6399999999999997, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.94, 1.64, 0.066], "rotation": [0, 0, -0.45]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftLeaf3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left ivory botanical leaf 3 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leftLeaf3_9.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftLeaf3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["leftDoor"] ?? root).add(node_leftLeaf3_9);
  nodes["leftLeaf3"] = node_leftLeaf3_9;
  const mesh_leftLeaf3_9Geometry = endpoint_leftLeaf3_9
    ? new THREE.CylinderGeometry(endpoint_leftLeaf3_9.endRadius, endpoint_leftLeaf3_9.baseRadius, endpoint_leftLeaf3_9.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028});
  if (!endpoint_leftLeaf3_9) {
    mesh_leftLeaf3_9Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leftLeaf3_9 = new THREE.Mesh(
    mesh_leftLeaf3_9Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leftLeaf3_9.name = "left ivory botanical leaf 3";
  if (endpoint_leftLeaf3_9) {
    mesh_leftLeaf3_9.position.copy(endpoint_leftLeaf3_9.midpoint);
    mesh_leftLeaf3_9.quaternion.copy(endpoint_leftLeaf3_9.quaternion);
  }
  mesh_leftLeaf3_9.castShadow = options.castShadow ?? true;
  mesh_leftLeaf3_9.receiveShadow = options.receiveShadow ?? true;
  mesh_leftLeaf3_9.userData.sculptComponent = {"id": "leftLeaf3", "name": "left ivory botanical leaf 3", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [0.94, 1.64, 0.085], "localEnd": [0.94, 2.6399999999999997, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.94, 1.64, 0.066], "rotation": [0, 0, -0.45]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftLeaf3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left ivory botanical leaf 3 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leftLeaf3_9.add(mesh_leftLeaf3_9);
  meshes["leftLeaf3"] = mesh_leftLeaf3_9;
  colliders["leftLeaf3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["leftLeaf3"] ??= [];
  destructionGroups["leftLeaf3"].push(node_leftLeaf3_9);

  const endpoint_leftLeaf4_10 = makeAttachmentEndpoint(null);
  const node_leftLeaf4_10 = new THREE.Group();
  node_leftLeaf4_10.name = "left ivory botanical leaf 4__pivot";
  node_leftLeaf4_10.scale.set(1, 1, 1);
  if (endpoint_leftLeaf4_10) {
    node_leftLeaf4_10.position.copy(endpoint_leftLeaf4_10.start);
    node_leftLeaf4_10.rotation.set(0.0, 0.0, 0.7);
  } else {
    node_leftLeaf4_10.position.set(0.64, 2.1, 0.066);
    node_leftLeaf4_10.rotation.set(0.0, 0.0, 0.7);
  }
  node_leftLeaf4_10.userData.sculptComponent = {"id": "leftLeaf4", "name": "left ivory botanical leaf 4", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [0.64, 2.1, 0.085], "localEnd": [0.64, 3.1, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.64, 2.1, 0.066], "rotation": [0, 0, 0.7]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftLeaf4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left ivory botanical leaf 4 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leftLeaf4_10.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftLeaf4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["leftDoor"] ?? root).add(node_leftLeaf4_10);
  nodes["leftLeaf4"] = node_leftLeaf4_10;
  const mesh_leftLeaf4_10Geometry = endpoint_leftLeaf4_10
    ? new THREE.CylinderGeometry(endpoint_leftLeaf4_10.endRadius, endpoint_leftLeaf4_10.baseRadius, endpoint_leftLeaf4_10.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028});
  if (!endpoint_leftLeaf4_10) {
    mesh_leftLeaf4_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leftLeaf4_10 = new THREE.Mesh(
    mesh_leftLeaf4_10Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leftLeaf4_10.name = "left ivory botanical leaf 4";
  if (endpoint_leftLeaf4_10) {
    mesh_leftLeaf4_10.position.copy(endpoint_leftLeaf4_10.midpoint);
    mesh_leftLeaf4_10.quaternion.copy(endpoint_leftLeaf4_10.quaternion);
  }
  mesh_leftLeaf4_10.castShadow = options.castShadow ?? true;
  mesh_leftLeaf4_10.receiveShadow = options.receiveShadow ?? true;
  mesh_leftLeaf4_10.userData.sculptComponent = {"id": "leftLeaf4", "name": "left ivory botanical leaf 4", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [0.64, 2.1, 0.085], "localEnd": [0.64, 3.1, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.64, 2.1, 0.066], "rotation": [0, 0, 0.7]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftLeaf4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left ivory botanical leaf 4 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leftLeaf4_10.add(mesh_leftLeaf4_10);
  meshes["leftLeaf4"] = mesh_leftLeaf4_10;
  colliders["leftLeaf4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["leftLeaf4"] ??= [];
  destructionGroups["leftLeaf4"].push(node_leftLeaf4_10);

  const endpoint_leftLeaf5_11 = makeAttachmentEndpoint(null);
  const node_leftLeaf5_11 = new THREE.Group();
  node_leftLeaf5_11.name = "left ivory botanical leaf 5__pivot";
  node_leftLeaf5_11.scale.set(1, 1, 1);
  if (endpoint_leftLeaf5_11) {
    node_leftLeaf5_11.position.copy(endpoint_leftLeaf5_11.start);
    node_leftLeaf5_11.rotation.set(0.0, 0.0, -0.5);
  } else {
    node_leftLeaf5_11.position.set(0.91, 2.55, 0.066);
    node_leftLeaf5_11.rotation.set(0.0, 0.0, -0.5);
  }
  node_leftLeaf5_11.userData.sculptComponent = {"id": "leftLeaf5", "name": "left ivory botanical leaf 5", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [0.91, 2.55, 0.085], "localEnd": [0.91, 3.55, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.91, 2.55, 0.066], "rotation": [0, 0, -0.5]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftLeaf5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left ivory botanical leaf 5 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leftLeaf5_11.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftLeaf5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["leftDoor"] ?? root).add(node_leftLeaf5_11);
  nodes["leftLeaf5"] = node_leftLeaf5_11;
  const mesh_leftLeaf5_11Geometry = endpoint_leftLeaf5_11
    ? new THREE.CylinderGeometry(endpoint_leftLeaf5_11.endRadius, endpoint_leftLeaf5_11.baseRadius, endpoint_leftLeaf5_11.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028});
  if (!endpoint_leftLeaf5_11) {
    mesh_leftLeaf5_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leftLeaf5_11 = new THREE.Mesh(
    mesh_leftLeaf5_11Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leftLeaf5_11.name = "left ivory botanical leaf 5";
  if (endpoint_leftLeaf5_11) {
    mesh_leftLeaf5_11.position.copy(endpoint_leftLeaf5_11.midpoint);
    mesh_leftLeaf5_11.quaternion.copy(endpoint_leftLeaf5_11.quaternion);
  }
  mesh_leftLeaf5_11.castShadow = options.castShadow ?? true;
  mesh_leftLeaf5_11.receiveShadow = options.receiveShadow ?? true;
  mesh_leftLeaf5_11.userData.sculptComponent = {"id": "leftLeaf5", "name": "left ivory botanical leaf 5", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [0.91, 2.55, 0.085], "localEnd": [0.91, 3.55, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.91, 2.55, 0.066], "rotation": [0, 0, -0.5]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftLeaf5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left ivory botanical leaf 5 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leftLeaf5_11.add(mesh_leftLeaf5_11);
  meshes["leftLeaf5"] = mesh_leftLeaf5_11;
  colliders["leftLeaf5"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["leftLeaf5"] ??= [];
  destructionGroups["leftLeaf5"].push(node_leftLeaf5_11);

  const endpoint_leftLeaf6_12 = makeAttachmentEndpoint(null);
  const node_leftLeaf6_12 = new THREE.Group();
  node_leftLeaf6_12.name = "left ivory botanical leaf 6__pivot";
  node_leftLeaf6_12.scale.set(1, 1, 1);
  if (endpoint_leftLeaf6_12) {
    node_leftLeaf6_12.position.copy(endpoint_leftLeaf6_12.start);
    node_leftLeaf6_12.rotation.set(0.0, 0.0, 0.5);
  } else {
    node_leftLeaf6_12.position.set(0.62, 3.1, 0.066);
    node_leftLeaf6_12.rotation.set(0.0, 0.0, 0.5);
  }
  node_leftLeaf6_12.userData.sculptComponent = {"id": "leftLeaf6", "name": "left ivory botanical leaf 6", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [0.62, 3.1, 0.085], "localEnd": [0.62, 4.1, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.62, 3.1, 0.066], "rotation": [0, 0, 0.5]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftLeaf6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left ivory botanical leaf 6 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leftLeaf6_12.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftLeaf6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["leftDoor"] ?? root).add(node_leftLeaf6_12);
  nodes["leftLeaf6"] = node_leftLeaf6_12;
  const mesh_leftLeaf6_12Geometry = endpoint_leftLeaf6_12
    ? new THREE.CylinderGeometry(endpoint_leftLeaf6_12.endRadius, endpoint_leftLeaf6_12.baseRadius, endpoint_leftLeaf6_12.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028});
  if (!endpoint_leftLeaf6_12) {
    mesh_leftLeaf6_12Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leftLeaf6_12 = new THREE.Mesh(
    mesh_leftLeaf6_12Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leftLeaf6_12.name = "left ivory botanical leaf 6";
  if (endpoint_leftLeaf6_12) {
    mesh_leftLeaf6_12.position.copy(endpoint_leftLeaf6_12.midpoint);
    mesh_leftLeaf6_12.quaternion.copy(endpoint_leftLeaf6_12.quaternion);
  }
  mesh_leftLeaf6_12.castShadow = options.castShadow ?? true;
  mesh_leftLeaf6_12.receiveShadow = options.receiveShadow ?? true;
  mesh_leftLeaf6_12.userData.sculptComponent = {"id": "leftLeaf6", "name": "left ivory botanical leaf 6", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "leftDoor", "attachment": {"parentId": "leftDoor", "parentSocket": "leftDoor-contact", "localStart": [0.62, 3.1, 0.085], "localEnd": [0.62, 4.1, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.62, 3.1, 0.066], "rotation": [0, 0, 0.5]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leftLeaf6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["left ivory botanical leaf 6 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_leftLeaf6_12.add(mesh_leftLeaf6_12);
  meshes["leftLeaf6"] = mesh_leftLeaf6_12;
  colliders["leftLeaf6"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["leftLeaf6"] ??= [];
  destructionGroups["leftLeaf6"].push(node_leftLeaf6_12);

  const endpoint_rightDoor_13 = makeAttachmentEndpoint(null);
  const node_rightDoor_13 = new THREE.Group();
  node_rightDoor_13.name = "right hinged ivory leaf__pivot";
  node_rightDoor_13.scale.set(1, 1, 1);
  if (endpoint_rightDoor_13) {
    node_rightDoor_13.position.copy(endpoint_rightDoor_13.start);
    node_rightDoor_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rightDoor_13.position.set(1.408, 0.09, 0.0);
    node_rightDoor_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_rightDoor_13.userData.sculptComponent = {"id": "rightDoor", "name": "right hinged ivory leaf", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-1.4, 0], [-1.4, 4.199999999999999], [-1.4, 4.199999999999999], [-1.3313052559416145, 4.198313638687241], [-1.2627760035386149, 4.193258617341075], [-1.1945773357624936, 4.184847113950693], [-1.1268735491774202, 4.173099392564522], [-1.0598277481354303, 4.158043754472361], [-0.9936014518437526, 4.139716470025093], [-0.9283542052508919, 4.118161691256229], [-0.8642431946888742, 4.093431345515802], [-0.8014228691976049, 4.06558501037282], [-0.740044568443603, 4.034689770087697], [-0.6802561581294896, 4.00082005400038], [-0.6222016737725568, 3.9640574572235634], [-0.5660209737105931, 3.9244905440729028], [-0.5118494021708963, 3.8822146347078315], [-0.45981746321417427, 3.8373315754969424], [-0.41005050633883333, 3.789949493661166], [-0.36266842450305714, 3.7401825367858255], [-0.3177853652921683, 3.6881505978291034], [-0.27550945592709697, 3.6339790262894063], [-0.23594254277643656, 3.577798326227443], [-0.19917994599961908, 3.5197438418705103], [-0.16531022991230304, 3.4599554315563967], [-0.13441498962717935, 3.3985771308023947], [-0.10656865448419861, 3.3357568053111253], [-0.08183830874377085, 3.2716457947491078], [-0.06028352997490738, 3.206398548156247], [-0.041956245527638325, 3.1401722518645694], [-0.026900607435477397, 3.0731264508225795], [-0.015152886049306646, 3.005422664237506], [-0.006741382658924211, 2.937223996461385], [-0.0016863613127586774, 2.868694744058385], [0.0, 2.8], [0, 0]], "depth": 0.075}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-contact", "localStart": [1.4, 0.12, 0], "localEnd": [1.4, 1.12, 0], "contactType": "hinge", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [1.408, 0.09, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "hinged-panel", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightDoor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right hinged ivory leaf observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightDoor_13.userData.actionProfile = {"animationRole": "hinged-panel", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightDoor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_rightDoor_13);
  nodes["rightDoor"] = node_rightDoor_13;
  const mesh_rightDoor_13Geometry = endpoint_rightDoor_13
    ? new THREE.CylinderGeometry(endpoint_rightDoor_13.endRadius, endpoint_rightDoor_13.baseRadius, endpoint_rightDoor_13.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0, 0], [-1.4, 0], [-1.4, 4.199999999999999], [-1.4, 4.199999999999999], [-1.3313052559416145, 4.198313638687241], [-1.2627760035386149, 4.193258617341075], [-1.1945773357624936, 4.184847113950693], [-1.1268735491774202, 4.173099392564522], [-1.0598277481354303, 4.158043754472361], [-0.9936014518437526, 4.139716470025093], [-0.9283542052508919, 4.118161691256229], [-0.8642431946888742, 4.093431345515802], [-0.8014228691976049, 4.06558501037282], [-0.740044568443603, 4.034689770087697], [-0.6802561581294896, 4.00082005400038], [-0.6222016737725568, 3.9640574572235634], [-0.5660209737105931, 3.9244905440729028], [-0.5118494021708963, 3.8822146347078315], [-0.45981746321417427, 3.8373315754969424], [-0.41005050633883333, 3.789949493661166], [-0.36266842450305714, 3.7401825367858255], [-0.3177853652921683, 3.6881505978291034], [-0.27550945592709697, 3.6339790262894063], [-0.23594254277643656, 3.577798326227443], [-0.19917994599961908, 3.5197438418705103], [-0.16531022991230304, 3.4599554315563967], [-0.13441498962717935, 3.3985771308023947], [-0.10656865448419861, 3.3357568053111253], [-0.08183830874377085, 3.2716457947491078], [-0.06028352997490738, 3.206398548156247], [-0.041956245527638325, 3.1401722518645694], [-0.026900607435477397, 3.0731264508225795], [-0.015152886049306646, 3.005422664237506], [-0.006741382658924211, 2.937223996461385], [-0.0016863613127586774, 2.868694744058385], [0.0, 2.8], [0, 0]], "depth": 0.075});
  if (!endpoint_rightDoor_13) {
    mesh_rightDoor_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rightDoor_13 = new THREE.Mesh(
    mesh_rightDoor_13Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rightDoor_13.name = "right hinged ivory leaf";
  if (endpoint_rightDoor_13) {
    mesh_rightDoor_13.position.copy(endpoint_rightDoor_13.midpoint);
    mesh_rightDoor_13.quaternion.copy(endpoint_rightDoor_13.quaternion);
  }
  mesh_rightDoor_13.castShadow = options.castShadow ?? true;
  mesh_rightDoor_13.receiveShadow = options.receiveShadow ?? true;
  mesh_rightDoor_13.userData.sculptComponent = {"id": "rightDoor", "name": "right hinged ivory leaf", "level": "macro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-1.4, 0], [-1.4, 4.199999999999999], [-1.4, 4.199999999999999], [-1.3313052559416145, 4.198313638687241], [-1.2627760035386149, 4.193258617341075], [-1.1945773357624936, 4.184847113950693], [-1.1268735491774202, 4.173099392564522], [-1.0598277481354303, 4.158043754472361], [-0.9936014518437526, 4.139716470025093], [-0.9283542052508919, 4.118161691256229], [-0.8642431946888742, 4.093431345515802], [-0.8014228691976049, 4.06558501037282], [-0.740044568443603, 4.034689770087697], [-0.6802561581294896, 4.00082005400038], [-0.6222016737725568, 3.9640574572235634], [-0.5660209737105931, 3.9244905440729028], [-0.5118494021708963, 3.8822146347078315], [-0.45981746321417427, 3.8373315754969424], [-0.41005050633883333, 3.789949493661166], [-0.36266842450305714, 3.7401825367858255], [-0.3177853652921683, 3.6881505978291034], [-0.27550945592709697, 3.6339790262894063], [-0.23594254277643656, 3.577798326227443], [-0.19917994599961908, 3.5197438418705103], [-0.16531022991230304, 3.4599554315563967], [-0.13441498962717935, 3.3985771308023947], [-0.10656865448419861, 3.3357568053111253], [-0.08183830874377085, 3.2716457947491078], [-0.06028352997490738, 3.206398548156247], [-0.041956245527638325, 3.1401722518645694], [-0.026900607435477397, 3.0731264508225795], [-0.015152886049306646, 3.005422664237506], [-0.006741382658924211, 2.937223996461385], [-0.0016863613127586774, 2.868694744058385], [0.0, 2.8], [0, 0]], "depth": 0.075}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-contact", "localStart": [1.4, 0.12, 0], "localEnd": [1.4, 1.12, 0], "contactType": "hinge", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [1.408, 0.09, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "hinged-panel", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightDoor", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right hinged ivory leaf observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightDoor_13.add(mesh_rightDoor_13);
  meshes["rightDoor"] = mesh_rightDoor_13;
  colliders["rightDoor"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rightDoor"] ??= [];
  destructionGroups["rightDoor"].push(node_rightDoor_13);

  const attachment_rightHinge0_14 = {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [0.012, 0.58, 0.045], "localEnd": [0.012, 0.83, 0.045], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]};
  const endpoint_rightHinge0_14 = makeAttachmentEndpoint(attachment_rightHinge0_14);
  const node_rightHinge0_14 = new THREE.Group();
  node_rightHinge0_14.name = "right brass hinge barrel 0__pivot";
  node_rightHinge0_14.scale.set(1, 1, 1);
  if (endpoint_rightHinge0_14) {
    node_rightHinge0_14.position.copy(endpoint_rightHinge0_14.start);
    node_rightHinge0_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rightHinge0_14.position.set(0.012, 0.58, 0.045);
    node_rightHinge0_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_rightHinge0_14.userData.sculptComponent = {"id": "rightHinge0", "name": "right brass hinge barrel 0", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [0.012, 0.58, 0.045], "localEnd": [0.012, 0.83, 0.045], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1, "height": 0.25, "depth": 0.1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.012, 0.58, 0.045], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightHinge0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "brass", "materialLayers": ["brass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right brass hinge barrel 0 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(132, 92, 44, 1)", "secondaryAlbedo": "rgba(132, 92, 44, 1)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightHinge0_14.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightHinge0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rightDoor"] ?? root).add(node_rightHinge0_14);
  nodes["rightHinge0"] = node_rightHinge0_14;
  const mesh_rightHinge0_14Geometry = endpoint_rightHinge0_14
    ? new THREE.CylinderGeometry(endpoint_rightHinge0_14.endRadius, endpoint_rightHinge0_14.baseRadius, endpoint_rightHinge0_14.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_rightHinge0_14) {
    mesh_rightHinge0_14Geometry.scale(0.1, 0.25, 0.1);
  }
  const mesh_rightHinge0_14 = new THREE.Mesh(
    mesh_rightHinge0_14Geometry,
    materialMap["brass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rightHinge0_14.name = "right brass hinge barrel 0";
  if (endpoint_rightHinge0_14) {
    mesh_rightHinge0_14.position.copy(endpoint_rightHinge0_14.midpoint);
    mesh_rightHinge0_14.quaternion.copy(endpoint_rightHinge0_14.quaternion);
  }
  mesh_rightHinge0_14.castShadow = options.castShadow ?? true;
  mesh_rightHinge0_14.receiveShadow = options.receiveShadow ?? true;
  mesh_rightHinge0_14.userData.sculptComponent = {"id": "rightHinge0", "name": "right brass hinge barrel 0", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [0.012, 0.58, 0.045], "localEnd": [0.012, 0.83, 0.045], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1, "height": 0.25, "depth": 0.1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.012, 0.58, 0.045], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightHinge0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "brass", "materialLayers": ["brass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right brass hinge barrel 0 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(132, 92, 44, 1)", "secondaryAlbedo": "rgba(132, 92, 44, 1)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightHinge0_14.add(mesh_rightHinge0_14);
  meshes["rightHinge0"] = mesh_rightHinge0_14;
  colliders["rightHinge0"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rightHinge0"] ??= [];
  destructionGroups["rightHinge0"].push(node_rightHinge0_14);

  const attachment_rightHinge1_15 = {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [0.012, 2.98, 0.045], "localEnd": [0.012, 3.23, 0.045], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]};
  const endpoint_rightHinge1_15 = makeAttachmentEndpoint(attachment_rightHinge1_15);
  const node_rightHinge1_15 = new THREE.Group();
  node_rightHinge1_15.name = "right brass hinge barrel 1__pivot";
  node_rightHinge1_15.scale.set(1, 1, 1);
  if (endpoint_rightHinge1_15) {
    node_rightHinge1_15.position.copy(endpoint_rightHinge1_15.start);
    node_rightHinge1_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rightHinge1_15.position.set(0.012, 2.98, 0.045);
    node_rightHinge1_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_rightHinge1_15.userData.sculptComponent = {"id": "rightHinge1", "name": "right brass hinge barrel 1", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [0.012, 2.98, 0.045], "localEnd": [0.012, 3.23, 0.045], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1, "height": 0.25, "depth": 0.1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.012, 2.98, 0.045], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightHinge1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "brass", "materialLayers": ["brass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right brass hinge barrel 1 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(132, 92, 44, 1)", "secondaryAlbedo": "rgba(132, 92, 44, 1)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightHinge1_15.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightHinge1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rightDoor"] ?? root).add(node_rightHinge1_15);
  nodes["rightHinge1"] = node_rightHinge1_15;
  const mesh_rightHinge1_15Geometry = endpoint_rightHinge1_15
    ? new THREE.CylinderGeometry(endpoint_rightHinge1_15.endRadius, endpoint_rightHinge1_15.baseRadius, endpoint_rightHinge1_15.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_rightHinge1_15) {
    mesh_rightHinge1_15Geometry.scale(0.1, 0.25, 0.1);
  }
  const mesh_rightHinge1_15 = new THREE.Mesh(
    mesh_rightHinge1_15Geometry,
    materialMap["brass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rightHinge1_15.name = "right brass hinge barrel 1";
  if (endpoint_rightHinge1_15) {
    mesh_rightHinge1_15.position.copy(endpoint_rightHinge1_15.midpoint);
    mesh_rightHinge1_15.quaternion.copy(endpoint_rightHinge1_15.quaternion);
  }
  mesh_rightHinge1_15.castShadow = options.castShadow ?? true;
  mesh_rightHinge1_15.receiveShadow = options.receiveShadow ?? true;
  mesh_rightHinge1_15.userData.sculptComponent = {"id": "rightHinge1", "name": "right brass hinge barrel 1", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [0.012, 2.98, 0.045], "localEnd": [0.012, 3.23, 0.045], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.1, "height": 0.25, "depth": 0.1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.012, 2.98, 0.045], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightHinge1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "brass", "materialLayers": ["brass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right brass hinge barrel 1 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(132, 92, 44, 1)", "secondaryAlbedo": "rgba(132, 92, 44, 1)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightHinge1_15.add(mesh_rightHinge1_15);
  meshes["rightHinge1"] = mesh_rightHinge1_15;
  colliders["rightHinge1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rightHinge1"] ??= [];
  destructionGroups["rightHinge1"].push(node_rightHinge1_15);

  const attachment_rightStem_16 = {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [0, 0, 0], "localEnd": [0, 1, 0], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]};
  const endpoint_rightStem_16 = makeAttachmentEndpoint(null);
  const node_rightStem_16 = new THREE.Group();
  node_rightStem_16.name = "right raised botanical stem__pivot";
  node_rightStem_16.scale.set(1, 1, 1);
  if (endpoint_rightStem_16) {
    node_rightStem_16.position.copy(endpoint_rightStem_16.start);
    node_rightStem_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rightStem_16.position.set(0.0, 0.0, 0.0);
    node_rightStem_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_rightStem_16.userData.sculptComponent = {"id": "rightStem", "name": "right raised botanical stem", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "curve-sweep", "topologyClass": "fiber-strand", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "curveSweep": {"spine": [[-0.32, 0.15, 0.08], [-0.75, 0.8, 0.08], [-0.55, 1.6, 0.08], [-0.92, 2.4, 0.08], [-0.68, 3.5, 0.08]], "crossSection": {"points": [[0.012, 0.0], [0.008485281374238571, 0.00848528137423857], [7.347880794884119e-19, 0.012], [-0.00848528137423857, 0.008485281374238571], [-0.012, 1.4695761589768239e-18], [-0.008485281374238573, -0.00848528137423857], [-2.2043642384652355e-18, -0.012], [0.008485281374238568, -0.008485281374238573]]}, "closed": false}}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [0, 0, 0], "localEnd": [0, 1, 0], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightStem", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "brass", "materialLayers": ["brass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right raised botanical stem observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(132, 92, 44, 1)", "secondaryAlbedo": "rgba(132, 92, 44, 1)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightStem_16.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightStem", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rightDoor"] ?? root).add(node_rightStem_16);
  nodes["rightStem"] = node_rightStem_16;
  const mesh_rightStem_16Geometry = endpoint_rightStem_16
    ? new THREE.CylinderGeometry(endpoint_rightStem_16.endRadius, endpoint_rightStem_16.baseRadius, endpoint_rightStem_16.length, 16, 6)
    : buildCurveSweepGeometry({"spine": [[-0.32, 0.15, 0.08], [-0.75, 0.8, 0.08], [-0.55, 1.6, 0.08], [-0.92, 2.4, 0.08], [-0.68, 3.5, 0.08]], "crossSection": {"points": [[0.012, 0.0], [0.008485281374238571, 0.00848528137423857], [7.347880794884119e-19, 0.012], [-0.00848528137423857, 0.008485281374238571], [-0.012, 1.4695761589768239e-18], [-0.008485281374238573, -0.00848528137423857], [-2.2043642384652355e-18, -0.012], [0.008485281374238568, -0.008485281374238573]]}, "closed": false});
  if (!endpoint_rightStem_16) {
    mesh_rightStem_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rightStem_16 = new THREE.Mesh(
    mesh_rightStem_16Geometry,
    materialMap["brass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rightStem_16.name = "right raised botanical stem";
  if (endpoint_rightStem_16) {
    mesh_rightStem_16.position.copy(endpoint_rightStem_16.midpoint);
    mesh_rightStem_16.quaternion.copy(endpoint_rightStem_16.quaternion);
  }
  mesh_rightStem_16.castShadow = options.castShadow ?? true;
  mesh_rightStem_16.receiveShadow = options.receiveShadow ?? true;
  mesh_rightStem_16.userData.sculptComponent = {"id": "rightStem", "name": "right raised botanical stem", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "curve-sweep", "topologyClass": "fiber-strand", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "curveSweep": {"spine": [[-0.32, 0.15, 0.08], [-0.75, 0.8, 0.08], [-0.55, 1.6, 0.08], [-0.92, 2.4, 0.08], [-0.68, 3.5, 0.08]], "crossSection": {"points": [[0.012, 0.0], [0.008485281374238571, 0.00848528137423857], [7.347880794884119e-19, 0.012], [-0.00848528137423857, 0.008485281374238571], [-0.012, 1.4695761589768239e-18], [-0.008485281374238573, -0.00848528137423857], [-2.2043642384652355e-18, -0.012], [0.008485281374238568, -0.008485281374238573]]}, "closed": false}}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [0, 0, 0], "localEnd": [0, 1, 0], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightStem", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "brass", "materialLayers": ["brass"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right raised botanical stem observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(132, 92, 44, 1)", "secondaryAlbedo": "rgba(132, 92, 44, 1)", "materialClass": "metal", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightStem_16.add(mesh_rightStem_16);
  meshes["rightStem"] = mesh_rightStem_16;
  colliders["rightStem"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rightStem"] ??= [];
  destructionGroups["rightStem"].push(node_rightStem_16);

  const endpoint_rightLeaf0_17 = makeAttachmentEndpoint(null);
  const node_rightLeaf0_17 = new THREE.Group();
  node_rightLeaf0_17.name = "right ivory botanical leaf 0__pivot";
  node_rightLeaf0_17.scale.set(1, 1, 1);
  if (endpoint_rightLeaf0_17) {
    node_rightLeaf0_17.position.copy(endpoint_rightLeaf0_17.start);
    node_rightLeaf0_17.rotation.set(0.0, 0.0, -0.6);
  } else {
    node_rightLeaf0_17.position.set(-0.42, 0.55, 0.066);
    node_rightLeaf0_17.rotation.set(0.0, 0.0, -0.6);
  }
  node_rightLeaf0_17.userData.sculptComponent = {"id": "rightLeaf0", "name": "right ivory botanical leaf 0", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [-0.42, 0.55, 0.085], "localEnd": [-0.42, 1.55, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.42, 0.55, 0.066], "rotation": [0, 0, -0.6]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right ivory botanical leaf 0 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightLeaf0_17.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rightDoor"] ?? root).add(node_rightLeaf0_17);
  nodes["rightLeaf0"] = node_rightLeaf0_17;
  const mesh_rightLeaf0_17Geometry = endpoint_rightLeaf0_17
    ? new THREE.CylinderGeometry(endpoint_rightLeaf0_17.endRadius, endpoint_rightLeaf0_17.baseRadius, endpoint_rightLeaf0_17.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028});
  if (!endpoint_rightLeaf0_17) {
    mesh_rightLeaf0_17Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rightLeaf0_17 = new THREE.Mesh(
    mesh_rightLeaf0_17Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rightLeaf0_17.name = "right ivory botanical leaf 0";
  if (endpoint_rightLeaf0_17) {
    mesh_rightLeaf0_17.position.copy(endpoint_rightLeaf0_17.midpoint);
    mesh_rightLeaf0_17.quaternion.copy(endpoint_rightLeaf0_17.quaternion);
  }
  mesh_rightLeaf0_17.castShadow = options.castShadow ?? true;
  mesh_rightLeaf0_17.receiveShadow = options.receiveShadow ?? true;
  mesh_rightLeaf0_17.userData.sculptComponent = {"id": "rightLeaf0", "name": "right ivory botanical leaf 0", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [-0.42, 0.55, 0.085], "localEnd": [-0.42, 1.55, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.42, 0.55, 0.066], "rotation": [0, 0, -0.6]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right ivory botanical leaf 0 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightLeaf0_17.add(mesh_rightLeaf0_17);
  meshes["rightLeaf0"] = mesh_rightLeaf0_17;
  colliders["rightLeaf0"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rightLeaf0"] ??= [];
  destructionGroups["rightLeaf0"].push(node_rightLeaf0_17);

  const endpoint_rightLeaf1_18 = makeAttachmentEndpoint(null);
  const node_rightLeaf1_18 = new THREE.Group();
  node_rightLeaf1_18.name = "right ivory botanical leaf 1__pivot";
  node_rightLeaf1_18.scale.set(1, 1, 1);
  if (endpoint_rightLeaf1_18) {
    node_rightLeaf1_18.position.copy(endpoint_rightLeaf1_18.start);
    node_rightLeaf1_18.rotation.set(0.0, 0.0, 0.5);
  } else {
    node_rightLeaf1_18.position.set(-0.72, 0.85, 0.066);
    node_rightLeaf1_18.rotation.set(0.0, 0.0, 0.5);
  }
  node_rightLeaf1_18.userData.sculptComponent = {"id": "rightLeaf1", "name": "right ivory botanical leaf 1", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [-0.72, 0.85, 0.085], "localEnd": [-0.72, 1.85, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.72, 0.85, 0.066], "rotation": [0, 0, 0.5]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right ivory botanical leaf 1 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightLeaf1_18.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rightDoor"] ?? root).add(node_rightLeaf1_18);
  nodes["rightLeaf1"] = node_rightLeaf1_18;
  const mesh_rightLeaf1_18Geometry = endpoint_rightLeaf1_18
    ? new THREE.CylinderGeometry(endpoint_rightLeaf1_18.endRadius, endpoint_rightLeaf1_18.baseRadius, endpoint_rightLeaf1_18.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028});
  if (!endpoint_rightLeaf1_18) {
    mesh_rightLeaf1_18Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rightLeaf1_18 = new THREE.Mesh(
    mesh_rightLeaf1_18Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rightLeaf1_18.name = "right ivory botanical leaf 1";
  if (endpoint_rightLeaf1_18) {
    mesh_rightLeaf1_18.position.copy(endpoint_rightLeaf1_18.midpoint);
    mesh_rightLeaf1_18.quaternion.copy(endpoint_rightLeaf1_18.quaternion);
  }
  mesh_rightLeaf1_18.castShadow = options.castShadow ?? true;
  mesh_rightLeaf1_18.receiveShadow = options.receiveShadow ?? true;
  mesh_rightLeaf1_18.userData.sculptComponent = {"id": "rightLeaf1", "name": "right ivory botanical leaf 1", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [-0.72, 0.85, 0.085], "localEnd": [-0.72, 1.85, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.72, 0.85, 0.066], "rotation": [0, 0, 0.5]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right ivory botanical leaf 1 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightLeaf1_18.add(mesh_rightLeaf1_18);
  meshes["rightLeaf1"] = mesh_rightLeaf1_18;
  colliders["rightLeaf1"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rightLeaf1"] ??= [];
  destructionGroups["rightLeaf1"].push(node_rightLeaf1_18);

  const endpoint_rightLeaf2_19 = makeAttachmentEndpoint(null);
  const node_rightLeaf2_19 = new THREE.Group();
  node_rightLeaf2_19.name = "right ivory botanical leaf 2__pivot";
  node_rightLeaf2_19.scale.set(1, 1, 1);
  if (endpoint_rightLeaf2_19) {
    node_rightLeaf2_19.position.copy(endpoint_rightLeaf2_19.start);
    node_rightLeaf2_19.rotation.set(0.0, 0.0, -0.7);
  } else {
    node_rightLeaf2_19.position.set(-0.54, 1.3, 0.066);
    node_rightLeaf2_19.rotation.set(0.0, 0.0, -0.7);
  }
  node_rightLeaf2_19.userData.sculptComponent = {"id": "rightLeaf2", "name": "right ivory botanical leaf 2", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [-0.54, 1.3, 0.085], "localEnd": [-0.54, 2.3, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.54, 1.3, 0.066], "rotation": [0, 0, -0.7]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right ivory botanical leaf 2 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightLeaf2_19.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rightDoor"] ?? root).add(node_rightLeaf2_19);
  nodes["rightLeaf2"] = node_rightLeaf2_19;
  const mesh_rightLeaf2_19Geometry = endpoint_rightLeaf2_19
    ? new THREE.CylinderGeometry(endpoint_rightLeaf2_19.endRadius, endpoint_rightLeaf2_19.baseRadius, endpoint_rightLeaf2_19.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028});
  if (!endpoint_rightLeaf2_19) {
    mesh_rightLeaf2_19Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rightLeaf2_19 = new THREE.Mesh(
    mesh_rightLeaf2_19Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rightLeaf2_19.name = "right ivory botanical leaf 2";
  if (endpoint_rightLeaf2_19) {
    mesh_rightLeaf2_19.position.copy(endpoint_rightLeaf2_19.midpoint);
    mesh_rightLeaf2_19.quaternion.copy(endpoint_rightLeaf2_19.quaternion);
  }
  mesh_rightLeaf2_19.castShadow = options.castShadow ?? true;
  mesh_rightLeaf2_19.receiveShadow = options.receiveShadow ?? true;
  mesh_rightLeaf2_19.userData.sculptComponent = {"id": "rightLeaf2", "name": "right ivory botanical leaf 2", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [-0.54, 1.3, 0.085], "localEnd": [-0.54, 2.3, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.54, 1.3, 0.066], "rotation": [0, 0, -0.7]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right ivory botanical leaf 2 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightLeaf2_19.add(mesh_rightLeaf2_19);
  meshes["rightLeaf2"] = mesh_rightLeaf2_19;
  colliders["rightLeaf2"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rightLeaf2"] ??= [];
  destructionGroups["rightLeaf2"].push(node_rightLeaf2_19);

  const endpoint_rightLeaf3_20 = makeAttachmentEndpoint(null);
  const node_rightLeaf3_20 = new THREE.Group();
  node_rightLeaf3_20.name = "right ivory botanical leaf 3__pivot";
  node_rightLeaf3_20.scale.set(1, 1, 1);
  if (endpoint_rightLeaf3_20) {
    node_rightLeaf3_20.position.copy(endpoint_rightLeaf3_20.start);
    node_rightLeaf3_20.rotation.set(0.0, 0.0, 0.45);
  } else {
    node_rightLeaf3_20.position.set(-0.94, 1.64, 0.066);
    node_rightLeaf3_20.rotation.set(0.0, 0.0, 0.45);
  }
  node_rightLeaf3_20.userData.sculptComponent = {"id": "rightLeaf3", "name": "right ivory botanical leaf 3", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [-0.94, 1.64, 0.085], "localEnd": [-0.94, 2.6399999999999997, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.94, 1.64, 0.066], "rotation": [0, 0, 0.45]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right ivory botanical leaf 3 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightLeaf3_20.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rightDoor"] ?? root).add(node_rightLeaf3_20);
  nodes["rightLeaf3"] = node_rightLeaf3_20;
  const mesh_rightLeaf3_20Geometry = endpoint_rightLeaf3_20
    ? new THREE.CylinderGeometry(endpoint_rightLeaf3_20.endRadius, endpoint_rightLeaf3_20.baseRadius, endpoint_rightLeaf3_20.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028});
  if (!endpoint_rightLeaf3_20) {
    mesh_rightLeaf3_20Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rightLeaf3_20 = new THREE.Mesh(
    mesh_rightLeaf3_20Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rightLeaf3_20.name = "right ivory botanical leaf 3";
  if (endpoint_rightLeaf3_20) {
    mesh_rightLeaf3_20.position.copy(endpoint_rightLeaf3_20.midpoint);
    mesh_rightLeaf3_20.quaternion.copy(endpoint_rightLeaf3_20.quaternion);
  }
  mesh_rightLeaf3_20.castShadow = options.castShadow ?? true;
  mesh_rightLeaf3_20.receiveShadow = options.receiveShadow ?? true;
  mesh_rightLeaf3_20.userData.sculptComponent = {"id": "rightLeaf3", "name": "right ivory botanical leaf 3", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [-0.94, 1.64, 0.085], "localEnd": [-0.94, 2.6399999999999997, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.94, 1.64, 0.066], "rotation": [0, 0, 0.45]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right ivory botanical leaf 3 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightLeaf3_20.add(mesh_rightLeaf3_20);
  meshes["rightLeaf3"] = mesh_rightLeaf3_20;
  colliders["rightLeaf3"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rightLeaf3"] ??= [];
  destructionGroups["rightLeaf3"].push(node_rightLeaf3_20);

  const endpoint_rightLeaf4_21 = makeAttachmentEndpoint(null);
  const node_rightLeaf4_21 = new THREE.Group();
  node_rightLeaf4_21.name = "right ivory botanical leaf 4__pivot";
  node_rightLeaf4_21.scale.set(1, 1, 1);
  if (endpoint_rightLeaf4_21) {
    node_rightLeaf4_21.position.copy(endpoint_rightLeaf4_21.start);
    node_rightLeaf4_21.rotation.set(0.0, 0.0, -0.7);
  } else {
    node_rightLeaf4_21.position.set(-0.64, 2.1, 0.066);
    node_rightLeaf4_21.rotation.set(0.0, 0.0, -0.7);
  }
  node_rightLeaf4_21.userData.sculptComponent = {"id": "rightLeaf4", "name": "right ivory botanical leaf 4", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [-0.64, 2.1, 0.085], "localEnd": [-0.64, 3.1, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.64, 2.1, 0.066], "rotation": [0, 0, -0.7]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right ivory botanical leaf 4 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightLeaf4_21.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rightDoor"] ?? root).add(node_rightLeaf4_21);
  nodes["rightLeaf4"] = node_rightLeaf4_21;
  const mesh_rightLeaf4_21Geometry = endpoint_rightLeaf4_21
    ? new THREE.CylinderGeometry(endpoint_rightLeaf4_21.endRadius, endpoint_rightLeaf4_21.baseRadius, endpoint_rightLeaf4_21.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028});
  if (!endpoint_rightLeaf4_21) {
    mesh_rightLeaf4_21Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rightLeaf4_21 = new THREE.Mesh(
    mesh_rightLeaf4_21Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rightLeaf4_21.name = "right ivory botanical leaf 4";
  if (endpoint_rightLeaf4_21) {
    mesh_rightLeaf4_21.position.copy(endpoint_rightLeaf4_21.midpoint);
    mesh_rightLeaf4_21.quaternion.copy(endpoint_rightLeaf4_21.quaternion);
  }
  mesh_rightLeaf4_21.castShadow = options.castShadow ?? true;
  mesh_rightLeaf4_21.receiveShadow = options.receiveShadow ?? true;
  mesh_rightLeaf4_21.userData.sculptComponent = {"id": "rightLeaf4", "name": "right ivory botanical leaf 4", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [-0.64, 2.1, 0.085], "localEnd": [-0.64, 3.1, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.64, 2.1, 0.066], "rotation": [0, 0, -0.7]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right ivory botanical leaf 4 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightLeaf4_21.add(mesh_rightLeaf4_21);
  meshes["rightLeaf4"] = mesh_rightLeaf4_21;
  colliders["rightLeaf4"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rightLeaf4"] ??= [];
  destructionGroups["rightLeaf4"].push(node_rightLeaf4_21);

  const endpoint_rightLeaf5_22 = makeAttachmentEndpoint(null);
  const node_rightLeaf5_22 = new THREE.Group();
  node_rightLeaf5_22.name = "right ivory botanical leaf 5__pivot";
  node_rightLeaf5_22.scale.set(1, 1, 1);
  if (endpoint_rightLeaf5_22) {
    node_rightLeaf5_22.position.copy(endpoint_rightLeaf5_22.start);
    node_rightLeaf5_22.rotation.set(0.0, 0.0, 0.5);
  } else {
    node_rightLeaf5_22.position.set(-0.91, 2.55, 0.066);
    node_rightLeaf5_22.rotation.set(0.0, 0.0, 0.5);
  }
  node_rightLeaf5_22.userData.sculptComponent = {"id": "rightLeaf5", "name": "right ivory botanical leaf 5", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [-0.91, 2.55, 0.085], "localEnd": [-0.91, 3.55, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.91, 2.55, 0.066], "rotation": [0, 0, 0.5]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right ivory botanical leaf 5 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightLeaf5_22.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rightDoor"] ?? root).add(node_rightLeaf5_22);
  nodes["rightLeaf5"] = node_rightLeaf5_22;
  const mesh_rightLeaf5_22Geometry = endpoint_rightLeaf5_22
    ? new THREE.CylinderGeometry(endpoint_rightLeaf5_22.endRadius, endpoint_rightLeaf5_22.baseRadius, endpoint_rightLeaf5_22.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028});
  if (!endpoint_rightLeaf5_22) {
    mesh_rightLeaf5_22Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rightLeaf5_22 = new THREE.Mesh(
    mesh_rightLeaf5_22Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rightLeaf5_22.name = "right ivory botanical leaf 5";
  if (endpoint_rightLeaf5_22) {
    mesh_rightLeaf5_22.position.copy(endpoint_rightLeaf5_22.midpoint);
    mesh_rightLeaf5_22.quaternion.copy(endpoint_rightLeaf5_22.quaternion);
  }
  mesh_rightLeaf5_22.castShadow = options.castShadow ?? true;
  mesh_rightLeaf5_22.receiveShadow = options.receiveShadow ?? true;
  mesh_rightLeaf5_22.userData.sculptComponent = {"id": "rightLeaf5", "name": "right ivory botanical leaf 5", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [-0.91, 2.55, 0.085], "localEnd": [-0.91, 3.55, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.91, 2.55, 0.066], "rotation": [0, 0, 0.5]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right ivory botanical leaf 5 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightLeaf5_22.add(mesh_rightLeaf5_22);
  meshes["rightLeaf5"] = mesh_rightLeaf5_22;
  colliders["rightLeaf5"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rightLeaf5"] ??= [];
  destructionGroups["rightLeaf5"].push(node_rightLeaf5_22);

  const endpoint_rightLeaf6_23 = makeAttachmentEndpoint(null);
  const node_rightLeaf6_23 = new THREE.Group();
  node_rightLeaf6_23.name = "right ivory botanical leaf 6__pivot";
  node_rightLeaf6_23.scale.set(1, 1, 1);
  if (endpoint_rightLeaf6_23) {
    node_rightLeaf6_23.position.copy(endpoint_rightLeaf6_23.start);
    node_rightLeaf6_23.rotation.set(0.0, 0.0, -0.5);
  } else {
    node_rightLeaf6_23.position.set(-0.62, 3.1, 0.066);
    node_rightLeaf6_23.rotation.set(0.0, 0.0, -0.5);
  }
  node_rightLeaf6_23.userData.sculptComponent = {"id": "rightLeaf6", "name": "right ivory botanical leaf 6", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [-0.62, 3.1, 0.085], "localEnd": [-0.62, 4.1, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.62, 3.1, 0.066], "rotation": [0, 0, -0.5]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right ivory botanical leaf 6 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightLeaf6_23.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rightDoor"] ?? root).add(node_rightLeaf6_23);
  nodes["rightLeaf6"] = node_rightLeaf6_23;
  const mesh_rightLeaf6_23Geometry = endpoint_rightLeaf6_23
    ? new THREE.CylinderGeometry(endpoint_rightLeaf6_23.endRadius, endpoint_rightLeaf6_23.baseRadius, endpoint_rightLeaf6_23.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028});
  if (!endpoint_rightLeaf6_23) {
    mesh_rightLeaf6_23Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rightLeaf6_23 = new THREE.Mesh(
    mesh_rightLeaf6_23Geometry,
    materialMap["ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rightLeaf6_23.name = "right ivory botanical leaf 6";
  if (endpoint_rightLeaf6_23) {
    mesh_rightLeaf6_23.position.copy(endpoint_rightLeaf6_23.midpoint);
    mesh_rightLeaf6_23.quaternion.copy(endpoint_rightLeaf6_23.quaternion);
  }
  mesh_rightLeaf6_23.castShadow = options.castShadow ?? true;
  mesh_rightLeaf6_23.receiveShadow = options.receiveShadow ?? true;
  mesh_rightLeaf6_23.userData.sculptComponent = {"id": "rightLeaf6", "name": "right ivory botanical leaf 6", "level": "micro", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Discrete rigid architectural or relief component; curve paths only for elongated stems.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.012, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0, 0], [-0.1, 0.09], [-0.14, 0.25], [0, 0.49], [0.14, 0.25], [0.1, 0.09]], "depth": 0.028}}, "parent": "rightDoor", "attachment": {"parentId": "rightDoor", "parentSocket": "rightDoor-contact", "localStart": [-0.62, 3.1, 0.085], "localEnd": [-0.62, 4.1, 0.085], "contactType": "surface-contact", "overlap": 0.025, "embedDepth": 0.025, "gapTolerance": 0.015, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [-0.62, 3.1, 0.066], "rotation": [0, 0, -0.5]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rightLeaf6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "ivory", "materialLayers": ["ivory"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.04, "microRoughness": 0.025, "bumpAmplitude": 0.001, "normalPattern": "Verified clean reference crop normal map, low-amplitude warm ivory stipple on panels and leaf caps; brass narrow-grain source, stone mottling on plinth.", "displacementPattern": "none: preserve hinge and seam geometry", "occlusionPattern": "Reference-derived AO map on each matching material; shallow relief contact is geometric.", "edgeWearPattern": "none observed; do not invent damage", "notes": "Map response is approximate inference from a single generated concept. Raised botanical identity is actual mesh geometry, not painted motif."}, "evidenceRefs": ["full-object"], "details": ["right ivory botanical leaf 6 observed in full-object"], "fidelityTier": "stylized", "colorMaterialRecipe": {"dominantAlbedo": "rgba(225, 207, 184, 1)", "secondaryAlbedo": "rgba(225, 207, 184, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.8, "evidenceRefs": ["full-object"], "notes": "Sampled median palette from material crop; roughness/metalness remain declared approximate response."}};
  node_rightLeaf6_23.add(mesh_rightLeaf6_23);
  meshes["rightLeaf6"] = mesh_rightLeaf6_23;
  colliders["rightLeaf6"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["rightLeaf6"] ??= [];
  destructionGroups["rightLeaf6"].push(node_rightLeaf6_23);
  // repetition system "botanical-leaves" describes 14 parts that are already built individually; not instanced.

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createStylizedIvoryAndBrassDoubleDoorArchPortalLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Stylized ivory and brass double-door arch portal look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"type": "key light", "direction": [-2, 5, 4], "color": "#fff6e6", "intensity": 3}, {"type": "fill light", "direction": [3, 2, 2], "color": "#e7eef5", "intensity": 1}, {"type": "rim or environment light", "direction": [0, 3, -3], "color": "#ffffff", "intensity": 1, "exposure": 1, "toneMapping": "ACESFilmic", "background": "transparent for reference comparison", "contactShadow": "disabled in deployment; plinth contact proven by geometry", "contact shadow": "No shadow maps. Contact ambient occlusion darkening only where door leaves and plinth touch; infer offscreen contact behavior explicitly."}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createStylizedIvoryAndBrassDoubleDoorArchPortalEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameStylizedIvoryAndBrassDoubleDoorArchPortalCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createStylizedIvoryAndBrassDoubleDoorArchPortalPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureStylizedIvoryAndBrassDoubleDoorArchPortalRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createStylizedIvoryAndBrassDoubleDoorArchPortalInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
