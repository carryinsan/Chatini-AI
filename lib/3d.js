/**
 * ArixAI 3D Scene Compiler — lib/3d.js
 * Dependency-free ES module for turning AI-authored declarative scene specs
 * into validated, bounded, frontend-ready 3D scene data.
 *
 * SECURITY CONTRACT:
 * - Never evaluates AI-generated JavaScript.
 * - Accepts JSON / JSON-like scene descriptions only.
 * - Repair is conservative: it fixes common formatting/syntax mistakes,
 *   not missing design intent or unknowable geometry.
 * - Render the returned scene with a frontend renderer such as Three.js.
 *
 * Node.js: import { compile3D } from "./lib/3d.js";
 */

const VERSION = "1.0.0";
const MAX_INPUT_CHARS = 1_000_000;
const MAX_OBJECTS = 2_000;
const MAX_MATERIALS = 500;
const MAX_LIGHTS = 32;
const MAX_STRING = 2_000;
const MAX_ABS_COORD = 1_000_000;
const MAX_DIMENSION = 1_000_000;
const MIN_DIMENSION = 1e-6;
const MAX_ARRAY_ITEMS = 100_000;
const MAX_REPAIR_ATTEMPTS = 6;

const PRIMITIVES = new Set([
  "box", "sphere", "cylinder", "cone", "torus", "plane", "capsule"
]);
const EASING = new Set(["linear", "smoothstep"]);
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d+)\s*\)|[a-z]{1,24})$/i;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function cleanString(value, fallback, max = MAX_STRING) {
  if (typeof value !== "string") return fallback;
  const s = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return s || fallback;
}
function num(value, fallback, min, max, warnings, path) {
  if (!finite(value)) {
    if (value !== undefined) warnings.push({ code: "INVALID_NUMBER", path, message: "Non-finite or non-numeric value replaced with a safe default." });
    return fallback;
  }
  const result = clamp(value, min, max);
  if (result !== value) warnings.push({ code: "NUMBER_CLAMPED", path, message: `Value was clamped to [${min}, ${max}].` });
  return result;
}
function vector3(value, fallback, limits, warnings, path) {
  const src = Array.isArray(value) ? value : isObject(value) ? [value.x, value.y, value.z] : [];
  if (!Array.isArray(value) && value !== undefined && !isObject(value)) {
    warnings.push({ code: "INVALID_VECTOR", path, message: "Vector replaced with default." });
  }
  return [0, 1, 2].map((i) => num(src[i], fallback[i], -limits, limits, warnings, `${path}[${i}]`));
}
function color(value, fallback, warnings, path) {
  if (typeof value !== "string" || !COLOR_RE.test(value.trim())) {
    if (value !== undefined) warnings.push({ code: "INVALID_COLOR", path, message: "Invalid color replaced with default." });
    return fallback;
  }
  return value.trim().slice(0, 80);
}
function safeObject(input, allowedKeys, warnings, path) {
  if (!isObject(input)) return {};
  const out = {};
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = input[key];
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) warnings.push({ code: "UNKNOWN_FIELD", path: `${path}.${key}`, message: "Unsupported field ignored." });
  }
  return out;
}
function stableId(value, fallback, seen) {
  let id = cleanString(value, fallback, 80).replace(/[^a-zA-Z0-9_.:-]/g, "_");
  if (!id) id = fallback;
  const base = id;
  let i = 2;
  while (seen.has(id)) id = `${base}_${i++}`;
  seen.add(id);
  return id;
}

/** Strip markdown fences and remove comments outside quoted strings. */
function preprocessText(input) {
  let s = input.trim();
  s = s.replace(/^```(?:json|javascript|js|jsonc)?\s*/i, "").replace(/\s*```$/, "");
  s = s.replace(/^\s*<escape>/, "").replace(/<\/escape>\s*$/, "");
  s = s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
  let out = "";
  let quote = null;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (quote) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === "/" && n === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < s.length - 1 && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out.trim();
}

/** Extract the most likely JSON object/array from surrounding prose. */
function extractCandidate(text) {
  const firstObject = text.indexOf("{");
  const firstArray = text.indexOf("[");
  let start;
  if (firstObject < 0) start = firstArray;
  else if (firstArray < 0) start = firstObject;
  else start = Math.min(firstObject, firstArray);
  if (start < 0) return text;
  const stack = [];
  let quote = null, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      const expected = c === "}" ? "{" : "[";
      if (stack[stack.length - 1] === expected) stack.pop();
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/** Conservative syntax repairs; does not run or interpret executable code. */
function repairJsonLike(text) {
  let s = text;
  // Remove trailing commas before closing braces/brackets.
  s = s.replace(/,\s*([}\]])/g, "$1");
  // Quote unquoted object keys. Restrict to simple identifiers.
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, '$1"$2"$3');
  // Convert single-quoted strings to JSON strings only when safely bounded.
  s = s.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, body) =>
    `"${body.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`
  );
  // Repair common JS-ish literals.
  s = s.replace(/\bundefined\b/g, "null").replace(/\bNaN\b/g, "null").replace(/\bInfinity\b/g, "null");
  return s;
}

function parseInput(input) {
  if (isObject(input)) return { parsed: input, repairs: [] };
  if (Array.isArray(input)) return { parsed: { objects: input }, repairs: ["Wrapped top-level array as objects."] };
  if (typeof input !== "string") {
    return { parsed: null, repairs: [], error: "Input must be a scene object or JSON-like string." };
  }
  if (input.length > MAX_INPUT_CHARS) {
    return { parsed: null, repairs: [], error: `Input exceeds ${MAX_INPUT_CHARS} characters.` };
  }
  const prepared = preprocessText(input);
  const candidate = extractCandidate(prepared);
  const attempts = [
    { text: candidate, label: "parsed original JSON" },
    { text: repairJsonLike(candidate), label: "repaired common JSON-like syntax" },
    { text: repairJsonLike(candidate).replace(/;\s*$/, ""), label: "removed trailing statement semicolon" }
  ];
  const seen = new Set();
  let lastError = "";
  for (const attempt of attempts.slice(0, MAX_REPAIR_ATTEMPTS)) {
    if (seen.has(attempt.text)) continue;
    seen.add(attempt.text);
    try {
      const value = JSON.parse(attempt.text);
      if (Array.isArray(value)) return { parsed: { objects: value }, repairs: [attempt.label, "Wrapped top-level array as objects."] };
      if (!isObject(value)) { lastError = "Parsed input is not a scene object."; continue; }
      return { parsed: value, repairs: attempt.label === "parsed original JSON" ? [] : [attempt.label] };
    } catch (err) {
      lastError = err instanceof Error ? err.message.slice(0, 240) : "Unknown parse error";
    }
  }
  return {
    parsed: null,
    repairs: [],
    error: `Could not safely parse scene description. ${lastError}`,
    hint: "Return a JSON object with an 'objects' array. Do not send JavaScript functions, imports, or executable code."
  };
}

function normalizeMaterial(raw, index, seen, warnings) {
  const path = `materials[${index}]`;
  const obj = safeObject(raw, ["id", "name", "color", "roughness", "metalness", "opacity", "transparent", "wireframe", "side", "emissive", "emissiveIntensity"], warnings, path);
  const id = stableId(obj.id, `material_${index + 1}`, seen);
  const opacity = num(obj.opacity, 1, 0, 1, warnings, `${path}.opacity`);
  const side = ["front", "back", "double"].includes(obj.side) ? obj.side : "front";
  return {
    id,
    name: cleanString(obj.name, id, 100),
    color: color(obj.color, "#b8c4d6", warnings, `${path}.color`),
    roughness: num(obj.roughness, 0.65, 0, 1, warnings, `${path}.roughness`),
    metalness: num(obj.metalness, 0, 0, 1, warnings, `${path}.metalness`),
    opacity,
    transparent: Boolean(obj.transparent) || opacity < 1,
    wireframe: Boolean(obj.wireframe),
    side,
    emissive: color(obj.emissive, "#000000", warnings, `${path}.emissive`),
    emissiveIntensity: num(obj.emissiveIntensity, 0, 0, 10, warnings, `${path}.emissiveIntensity`)
  };
}

function normalizeGeometry(raw, primitive, warnings, path) {
  const allowed = {
    box: ["width", "height", "depth", "segments"],
    sphere: ["radius", "widthSegments", "heightSegments"],
    cylinder: ["radiusTop", "radiusBottom", "height", "radialSegments", "openEnded"],
    cone: ["radius", "height", "radialSegments", "openEnded"],
    torus: ["radius", "tube", "radialSegments", "tubularSegments", "arc"],
    plane: ["width", "height", "widthSegments", "heightSegments"],
    capsule: ["radius", "length", "capSegments", "radialSegments"]
  }[primitive];
  const g = safeObject(raw, allowed, warnings, `${path}.geometry`);
  const dim = (v, fallback, p) => num(v, fallback, MIN_DIMENSION, MAX_DIMENSION, warnings, p);
  const seg = (v, fallback, min, max, p) => Math.round(num(v, fallback, min, max, warnings, p));
  switch (primitive) {
    case "box": return {
      width: dim(g.width, 1, `${path}.geometry.width`),
      height: dim(g.height, 1, `${path}.geometry.height`),
      depth: dim(g.depth, 1, `${path}.geometry.depth`),
      widthSegments: seg(g.segments?.[0], 1, 1, 256, `${path}.geometry.segments[0]`),
      heightSegments: seg(g.segments?.[1], 1, 1, 256, `${path}.geometry.segments[1]`),
      depthSegments: seg(g.segments?.[2], 1, 1, 256, `${path}.geometry.segments[2]`)
    };
    case "sphere": return {
      radius: dim(g.radius, 1, `${path}.geometry.radius`),
      widthSegments: seg(g.widthSegments, 32, 3, 512, `${path}.geometry.widthSegments`),
      heightSegments: seg(g.heightSegments, 16, 2, 512, `${path}.geometry.heightSegments`)
    };
    case "cylinder": return {
      radiusTop: dim(g.radiusTop, 1, `${path}.geometry.radiusTop`),
      radiusBottom: dim(g.radiusBottom, 1, `${path}.geometry.radiusBottom`),
      height: dim(g.height, 1, `${path}.geometry.height`),
      radialSegments: seg(g.radialSegments, 32, 3, 512, `${path}.geometry.radialSegments`),
      openEnded: Boolean(g.openEnded)
    };
    case "cone": return {
      radius: dim(g.radius, 1, `${path}.geometry.radius`),
      height: dim(g.height, 1, `${path}.geometry.height`),
      radialSegments: seg(g.radialSegments, 32, 3, 512, `${path}.geometry.radialSegments`),
      openEnded: Boolean(g.openEnded)
    };
    case "torus": return {
      radius: dim(g.radius, 1, `${path}.geometry.radius`),
      tube: dim(g.tube, 0.25, `${path}.geometry.tube`),
      radialSegments: seg(g.radialSegments, 16, 3, 256, `${path}.geometry.radialSegments`),
      tubularSegments: seg(g.tubularSegments, 64, 3, 512, `${path}.geometry.tubularSegments`),
      arc: num(g.arc, Math.PI * 2, 0.001, Math.PI * 2, warnings, `${path}.geometry.arc`)
    };
    case "plane": return {
      width: dim(g.width, 10, `${path}.geometry.width`),
      height: dim(g.height, 10, `${path}.geometry.height`),
      widthSegments: seg(g.widthSegments, 1, 1, 256, `${path}.geometry.widthSegments`),
      heightSegments: seg(g.heightSegments, 1, 1, 256, `${path}.geometry.heightSegments`)
    };
    case "capsule": return {
      radius: dim(g.radius, 0.5, `${path}.geometry.radius`),
      length: dim(g.length, 1, `${path}.geometry.length`),
      capSegments: seg(g.capSegments, 4, 1, 32, `${path}.geometry.capSegments`),
      radialSegments: seg(g.radialSegments, 16, 3, 256, `${path}.geometry.radialSegments`)
    };
    default: return {};
  }
}

function normalizeObject(raw, index, ids, materialIds, warnings) {
  const path = `objects[${index}]`;
  const allowed = ["id", "name", "type", "primitive", "geometry", "position", "rotation", "scale", "material", "visible", "castShadow", "receiveShadow", "userData"];
  const obj = safeObject(raw, allowed, warnings, path);
  let primitive = cleanString(obj.primitive ?? obj.type, "box", 40).toLowerCase();
  if (!PRIMITIVES.has(primitive)) {
    warnings.push({ code: "UNSUPPORTED_PRIMITIVE", path: `${path}.primitive`, message: `Unsupported primitive '${primitive}' replaced with box. Geometry intent may be lost.` });
    primitive = "box";
  }
  const id = stableId(obj.id, `object_${index + 1}`, ids);
  let material = cleanString(obj.material, "default", 100);
  if (material !== "default" && !materialIds.has(material)) {
    warnings.push({ code: "MISSING_MATERIAL", path: `${path}.material`, message: `Material '${material}' does not exist; using default material.` });
    material = "default";
  }
  const scaleRaw = obj.scale === undefined ? [1, 1, 1] : obj.scale;
  const scale = vector3(scaleRaw, [1, 1, 1], MAX_ABS_COORD, warnings, `${path}.scale`).map((v, i) => {
    if (Math.abs(v) < 1e-6) {
      warnings.push({ code: "ZERO_SCALE", path: `${path}.scale[${i}]`, message: "Near-zero scale replaced with 1 to avoid degenerate geometry." });
      return 1;
    }
    return v;
  });
  const userData = isObject(obj.userData) ? sanitizePlainData(obj.userData, warnings, `${path}.userData`, 0) : {};
  return {
    id,
    name: cleanString(obj.name, id, 120),
    primitive,
    geometry: normalizeGeometry(obj.geometry, primitive, warnings, path),
    position: vector3(obj.position, [0, 0, 0], MAX_ABS_COORD, warnings, `${path}.position`),
    // Rotation is expressed in radians, matching Three.js.
    rotation: vector3(obj.rotation, [0, 0, 0], Math.PI * 1_000, warnings, `${path}.rotation`),
    scale,
    material,
    visible: obj.visible !== false,
    castShadow: obj.castShadow !== false,
    receiveShadow: Boolean(obj.receiveShadow),
    userData
  };
}

function sanitizePlainData(value, warnings, path, depth) {
  if (depth > 8) {
    warnings.push({ code: "DATA_DEPTH_LIMIT", path, message: "Nested user data exceeded depth limit and was dropped." });
    return null;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 1000);
  if (finite(value)) return clamp(value, -MAX_ABS_COORD, MAX_ABS_COORD);
  if (Array.isArray(value)) return value.slice(0, 100).map((v, i) => sanitizePlainData(v, warnings, `${path}[${i}]`, depth + 1));
  if (isObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 100)) {
      if (["__proto__", "prototype", "constructor"].includes(k)) continue;
      out[cleanString(k, "key", 100)] = sanitizePlainData(v, warnings, `${path}.${k}`, depth + 1);
    }
    return out;
  }
  warnings.push({ code: "UNSAFE_USER_DATA", path, message: "Unsupported user data value dropped." });
  return null;
}

function normalizeLight(raw, index, warnings) {
  const path = `lights[${index}]`;
  const obj = safeObject(raw, ["type", "color", "intensity", "position", "distance", "decay", "angle", "penumbra", "castShadow"], warnings, path);
  const types = new Set(["ambient", "directional", "point", "spot", "hemisphere"]);
  let type = cleanString(obj.type, "directional", 30).toLowerCase();
  if (!types.has(type)) {
    warnings.push({ code: "INVALID_LIGHT", path: `${path}.type`, message: "Unknown light type replaced with directional." });
    type = "directional";
  }
  return {
    type,
    color: color(obj.color, "#ffffff", warnings, `${path}.color`),
    intensity: num(obj.intensity, type === "ambient" ? 0.6 : 1, 0, 100, warnings, `${path}.intensity`),
    position: vector3(obj.position, [5, 8, 6], MAX_ABS_COORD, warnings, `${path}.position`),
    distance: num(obj.distance, 0, 0, MAX_ABS_COORD, warnings, `${path}.distance`),
    decay: num(obj.decay, 2, 0, 10, warnings, `${path}.decay`),
    angle: num(obj.angle, Math.PI / 3, 0.001, Math.PI / 2, warnings, `${path}.angle`),
    penumbra: num(obj.penumbra, 0.1, 0, 1, warnings, `${path}.penumbra`),
    castShadow: Boolean(obj.castShadow)
  };
}

function normalizeCamera(raw, warnings) {
  const path = "camera";
  const obj = safeObject(raw, ["position", "target", "fov", "near", "far", "zoom"], warnings, path);
  const near = num(obj.near, 0.1, 0.001, 10_000, warnings, `${path}.near`);
  const far = num(obj.far, 10_000, near + 0.01, 100_000_000, warnings, `${path}.far`);
  return {
    position: vector3(obj.position, [6, 5, 8], MAX_ABS_COORD, warnings, `${path}.position`),
    target: vector3(obj.target, [0, 0, 0], MAX_ABS_COORD, warnings, `${path}.target`),
    fov: num(obj.fov, 45, 1, 120, warnings, `${path}.fov`),
    near,
    far: Math.max(far, near + 0.01),
    zoom: num(obj.zoom, 1, 0.01, 100, warnings, `${path}.zoom`)
  };
}

function normalizeEnvironment(raw, warnings) {
  const obj = safeObject(raw, ["background", "ground", "grid", "axes", "toneMapping", "exposure"], warnings, "environment");
  const ground = isObject(obj.ground) ? {
    enabled: obj.ground.enabled !== false,
    color: color(obj.ground.color, "#e9edf2", warnings, "environment.ground.color"),
    size: num(obj.ground.size, 100, 1, MAX_DIMENSION, warnings, "environment.ground.size"),
    y: num(obj.ground.y, -0.01, -MAX_ABS_COORD, MAX_ABS_COORD, warnings, "environment.ground.y")
  } : { enabled: true, color: "#e9edf2", size: 100, y: -0.01 };
  return {
    background: color(obj.background, "#f4f6f9", warnings, "environment.background"),
    ground,
    grid: obj.grid !== false,
    axes: Boolean(obj.axes),
    toneMapping: ["none", "linear", "reinhard", "aces"].includes(obj.toneMapping) ? obj.toneMapping : "aces",
    exposure: num(obj.exposure, 1, 0.01, 10, warnings, "environment.exposure")
  };
}

function normalizeAnimation(raw, objectIds, warnings) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push({ code: "INVALID_ANIMATION", path: "animations", message: "Animations must be an array; dropped." });
    return [];
  }
  if (raw.length > 100) warnings.push({ code: "ANIMATION_LIMIT", path: "animations", message: "Only the first 100 animations are considered." });
  return raw.slice(0, 100).flatMap((entry, i) => {
    const path = `animations[${i}]`;
    const a = safeObject(entry, ["objectId", "property", "from", "to", "duration", "repeat", "yoyo", "easing"], warnings, path);
    if (!objectIds.has(a.objectId)) {
      warnings.push({ code: "ANIMATION_TARGET_MISSING", path, message: "Animation target not found; animation dropped." });
      return [];
    }
    const property = ["position.x", "position.y", "position.z", "rotation.x", "rotation.y", "rotation.z", "scale.x", "scale.y", "scale.z"].includes(a.property) ? a.property : null;
    if (!property) {
      warnings.push({ code: "ANIMATION_PROPERTY_INVALID", path, message: "Unsupported animation property; animation dropped." });
      return [];
    }
    return [{
      objectId: a.objectId,
      property,
      from: num(a.from, 0, -MAX_ABS_COORD, MAX_ABS_COORD, warnings, `${path}.from`),
      to: num(a.to, 1, -MAX_ABS_COORD, MAX_ABS_COORD, warnings, `${path}.to`),
      duration: num(a.duration, 1000, 16, 3_600_000, warnings, `${path}.duration`),
      repeat: a.repeat === true ? true : Math.round(num(a.repeat, 0, 0, 100_000, warnings, `${path}.repeat`)),
      yoyo: Boolean(a.yoyo),
      easing: EASING.has(a.easing) ? a.easing : "smoothstep"
    }];
  });
}

function normalizeScene(raw, parseRepairs = []) {
  const warnings = [];
  const top = safeObject(raw, ["version", "title", "units", "camera", "environment", "materials", "lights", "objects", "animations", "metadata"], warnings, "scene");
  const rawObjects = Array.isArray(top.objects) ? top.objects : [];
  if (!Array.isArray(top.objects)) warnings.push({ code: "OBJECTS_DEFAULTED", path: "objects", message: "Missing or invalid objects array; an empty scene was created." });
  if (rawObjects.length > MAX_OBJECTS) warnings.push({ code: "OBJECT_LIMIT", path: "objects", message: `Only the first ${MAX_OBJECTS} objects are accepted.` });
  const rawMaterials = Array.isArray(top.materials) ? top.materials : [];
  if (rawMaterials.length > MAX_MATERIALS) warnings.push({ code: "MATERIAL_LIMIT", path: "materials", message: `Only the first ${MAX_MATERIALS} materials are accepted.` });
  const materialSeen = new Set();
  const materials = rawMaterials.slice(0, MAX_MATERIALS).map((m, i) => normalizeMaterial(m, i, materialSeen, warnings));
  const materialIds = new Set(materials.map(m => m.id));
  const ids = new Set();
  const objects = rawObjects.slice(0, MAX_OBJECTS).filter(isObject).map((o, i) => normalizeObject(o, i, ids, materialIds, warnings));
  const objectIds = new Set(objects.map(o => o.id));
  const rawLights = Array.isArray(top.lights) ? top.lights : [
    { type: "ambient", intensity: 0.7 },
    { type: "directional", intensity: 1.4, position: [5, 8, 6], castShadow: true }
  ];
  if (rawLights.length > MAX_LIGHTS) warnings.push({ code: "LIGHT_LIMIT", path: "lights", message: `Only the first ${MAX_LIGHTS} lights are accepted.` });
  const lights = rawLights.slice(0, MAX_LIGHTS).map((light, i) => normalizeLight(light, i, warnings));
  const animations = normalizeAnimation(top.animations, objectIds, warnings);
  const metadata = isObject(top.metadata) ? sanitizePlainData(top.metadata, warnings, "metadata", 0) : {};
  return {
    schema: "arixai.scene",
    version: 1,
    compilerVersion: VERSION,
    title: cleanString(top.title, "ArixAI 3D Scene", 160),
    units: cleanString(top.units, "unitless", 40),
    camera: normalizeCamera(top.camera, warnings),
    environment: normalizeEnvironment(top.environment, warnings),
    materials,
    lights,
    objects,
    animations,
    metadata,
    diagnostics: {
      status: warnings.length === 0 && parseRepairs.length === 0 ? "clean" : "repaired_or_warned",
      repaired: parseRepairs.length > 0,
      repairs: parseRepairs,
      warnings
    }
  };
}

/**
 * Compile AI output or a scene object into a safe normalized scene.
 *
 * Returns:
 * {
 *   ok: boolean,
 *   scene: normalized scene | null,
 *   diagnostics: { status, repaired, repairs, warnings, errors },
 *   error?: string,
 *   hint?: string
 * }
 */
export function compile3D(input, options = {}) {
  try {
    const parsed = parseInput(input);
    if (!parsed.parsed) {
      return {
        ok: false,
        scene: null,
        error: parsed.error || "Unable to parse scene input.",
        hint: parsed.hint || "Provide a JSON scene description.",
        diagnostics: { status: "failed", repaired: false, repairs: [], warnings: [], errors: [parsed.error || "Parse failure"] }
      };
    }
    const scene = normalizeScene(parsed.parsed, parsed.repairs);
    const warnings = scene.diagnostics.warnings;
    const fatal = [];
    if (scene.objects.length === 0) {
      warnings.push({ code: "EMPTY_SCENE", path: "objects", message: "Scene contains no objects; the frontend will render an empty scene." });
    }
    // Optional strict mode turns any repair/warning into a non-ok result, while preserving scene for debugging.
    const strictFailure = options.strict === true && (warnings.length > 0 || parsed.repairs.length > 0);
    return {
      ok: !strictFailure,
      scene,
      diagnostics: {
        ...scene.diagnostics,
        errors: fatal,
        status: strictFailure ? "strict_validation_failed" : scene.diagnostics.status
      },
      ...(strictFailure ? { error: "Strict validation failed because the scene required repair or produced warnings." } : {})
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected compiler failure.";
    return {
      ok: false,
      scene: null,
      error: `Scene compilation failed safely: ${message.slice(0, 300)}`,
      hint: "Retry with a smaller declarative JSON scene. Do not send executable code.",
      diagnostics: { status: "failed", repaired: false, repairs: [], warnings: [], errors: [message.slice(0, 300)] }
    };
  }
}

/** Alias for callers that prefer a descriptive name. */
export const compileScene = compile3D;

/** Convenience validation helper. A valid scene may still contain warnings. */
export function validate3D(input) {
  const result = compile3D(input, { strict: true });
  return {
    valid: result.ok,
    diagnostics: result.diagnostics,
    error: result.error || null
  };
}

/**
 * Return a compact, safe JSON payload suitable for sending to a frontend.
 * It contains only normalized data and never executable code.
 */
export function toFrontendScene(input, options = {}) {
  const result = compile3D(input, options);
  if (!result.scene) return result;
  return {
    ok: result.ok,
    scene: result.scene,
    diagnostics: result.diagnostics,
    ...(result.error ? { error: result.error } : {})
  };
}

/**
 * Creates a minimal example scene for tests/documentation.
 * This function is deterministic and does not use AI or external services.
 */
export function exampleScene() {
  return {
    version: 1,
    title: "Precision Test Scene",
    units: "meters",
    camera: { position: [5, 4, 7], target: [0, 0.5, 0], fov: 42 },
    environment: { background: "#f3f6fb", grid: true, axes: false },
    materials: [
      { id: "mat_body", color: "#5279c7", roughness: 0.4, metalness: 0.1 },
      { id: "mat_accent", color: "#e8a44b", roughness: 0.35, metalness: 0.2 }
    ],
    lights: [
      { type: "ambient", intensity: 0.65 },
      { type: "directional", intensity: 1.5, position: [4, 8, 5], castShadow: true }
    ],
    objects: [
      { id: "body", name: "Main body", primitive: "box", geometry: { width: 2, height: 1, depth: 1.2 }, position: [0, 0.5, 0], material: "mat_body" },
      { id: "top", name: "Top sphere", primitive: "sphere", geometry: { radius: 0.35, widthSegments: 48, heightSegments: 24 }, position: [0, 1.25, 0], material: "mat_accent" }
    ],
    animations: [
      { objectId: "top", property: "rotation.y", from: 0, to: 6.283185307179586, duration: 5000, repeat: true, easing: "linear" }
    ],
    metadata: { coordinateSystem: "right-handed", rotationUnit: "radians" }
  };
}
