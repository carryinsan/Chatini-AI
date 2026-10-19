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

const VERSION = "4.0.0";
const MAX_INPUT_CHARS = 1_000_000;
const MAX_OBJECTS = 4_000;
const MAX_EXPANDED_OBJECTS = 5_000;
const MAX_MATERIALS = 500;
const MAX_LIGHTS = 32;
const MAX_STRING = 2_000;
const MAX_ABS_COORD = 1_000_000;
const MAX_DIMENSION = 1_000_000;
const MIN_DIMENSION = 1e-6;
const MAX_REPAIR_ATTEMPTS = 12;
const MAX_MESH_VERTICES = 60_000;
const MAX_MESH_INDICES = 360_000;
const MAX_PROFILE_POINTS = 512;
const MAX_PATH_POINTS = 4_000;
const MESH_PRIMITIVE_RECIPES = Object.freeze({
  beveled_box: "beveled_box",
  extruded_profile: "extrude",
  lathe: "lathe",
  sweep_tube: "sweep",
  gear_mesh: "gear",
  spring_mesh: "spring",
  capsule_mesh: "capsule",
  loft_bishop: "loft_bishop",
  sdf: "sdf"
});
const MESH_RECIPES = new Set(["custom", "beveled_box", "extrude", "lathe", "sweep", "gear", "spring", "capsule", "loft_bishop", "sdf", "sdf_dual_contouring"]);

const EASING = new Set(["linear", "smoothstep"]);
const COLOR_RE = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgb\(\s*[-+.%\d\s,]+\)|rgba\(\s*[-+.%\d\s,]+\)|hsl\(\s*[-+.%\d\s,deg]+\)|hsla\(\s*[-+.%\d\s,deg]+\)|[a-z]{1,32})$/i;
const CSS_COLOR_NAMES = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen" ).split(/\s+/));
const BASE_PRIMITIVES = new Set(["box", "sphere", "cylinder", "cone", "torus", "plane", "capsule"]);
const PRIMITIVE_ALIASES = Object.freeze({
  block: "box", cuboid: "box", rectangular_prism: "box", rectangularprism: "box",
  ball: "sphere", orb: "sphere", ellipsoid: "sphere",
  rod: "cylinder", tube_solid: "cylinder", disk: "cylinder", disc: "cylinder",
  ring: "torus", donut: "torus", washer: "torus",
  triangular_prism: "cylinder", triangularprism: "cylinder",
  hex_prism: "cylinder", hexagonal_prism: "cylinder",
  octagonal_prism: "cylinder", pyramid: "cone"
});

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
  // Accept CSS colors plus numeric and normalized RGB forms; emit a renderer-safe CSS string.
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.round(clamp(value, 0, 0xffffff));
    return `#${n.toString(16).padStart(6, "0")}`;
  }
  if (Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(finite)) {
    const normalized = value.slice(0, 3).every((v) => v >= 0 && v <= 1);
    const channels = value.slice(0, 3).map((v) => Math.round(clamp(normalized ? v * 255 : v, 0, 255)));
    return `#${channels.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }
  if (isObject(value) && [value.r, value.g, value.b].every(finite)) {
    const raw = [value.r, value.g, value.b];
    const normalized = raw.every((v) => v >= 0 && v <= 1);
    const channels = raw.map((v) => Math.round(clamp(normalized ? v * 255 : v, 0, 255)));
    return `#${channels.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }
  if (typeof value !== "string" || !COLOR_RE.test(value.trim())) {
    if (value !== undefined) warnings.push({ code: "INVALID_COLOR", path, message: "Invalid color replaced with default. Use CSS names, hex, rgb()/rgba(), hsl()/hsla(), or RGB arrays." });
    return fallback;
  }
  let result = value.trim().slice(0, 96);
  if (/^[a-z]{1,32}$/i.test(result) && !CSS_COLOR_NAMES.has(result.toLowerCase())) {
    warnings.push({ code: "INVALID_COLOR_NAME", path, message: `Unknown CSS color name '${result}' replaced with default.` });
    return fallback;
  }
  if (/^#[0-9a-f]{4}$/i.test(result)) {
    result = `#${result[1]}${result[1]}${result[2]}${result[2]}${result[3]}${result[3]}`;
    warnings.push({ code: "COLOR_ALPHA_IGNORED", path, message: "Alpha in 4-digit hex was ignored; use material.opacity for transparency." });
  } else if (/^#[0-9a-f]{8}$/i.test(result)) {
    result = result.slice(0, 7); // Three.js r128 Color expects RGB; material opacity is a separate field.
    warnings.push({ code: "COLOR_ALPHA_IGNORED", path, message: "Alpha in 8-digit hex was ignored; use material.opacity for transparency." });
  } else if (/^(rgba|hsla)\(/i.test(result)) {
    warnings.push({ code: "COLOR_ALPHA_IGNORED", path, message: "Alpha in rgba()/hsla() was ignored; use material.opacity for transparency." });
  }
  // CSS Color functions can contain values outside CSS bounds; retain them only when syntactically simple.
  if (/^(?:rgb|rgba)\(/i.test(result)) {
    const nums = result.match(/[-+]?(?:\d*\.)?\d+%?/g) || [];
    const channels = nums.slice(0, 3).every((v) => v.endsWith("%") ? Number(v.slice(0, -1)) >= 0 && Number(v.slice(0, -1)) <= 100 : Number(v) >= 0 && Number(v) <= 255);
    const alpha = nums[3];
    const alphaValid = !alpha || (alpha.endsWith("%") ? Number(alpha.slice(0, -1)) >= 0 && Number(alpha.slice(0, -1)) <= 100 : Number(alpha) >= 0 && Number(alpha) <= 1);
    if (!channels || !alphaValid) {
      warnings.push({ code: "INVALID_COLOR_CHANNEL", path, message: "RGB channel or alpha was out of range; default color used." });
      return fallback;
    }
  }
  if (/^(?:hsl|hsla)\(/i.test(result)) {
    const nums = result.match(/[-+]?(?:\d*\.)?\d+%?/g) || [];
    const saturation = nums[1], lightness = nums[2], alpha = nums[3];
    const inPercent = (v) => !v || (v.endsWith("%") && Number(v.slice(0, -1)) >= 0 && Number(v.slice(0, -1)) <= 100);
    const alphaValid = !alpha || (alpha.endsWith("%") ? Number(alpha.slice(0, -1)) >= 0 && Number(alpha.slice(0, -1)) <= 100 : Number(alpha) >= 0 && Number(alpha) <= 1);
    if (!inPercent(saturation) || !inPercent(lightness) || !alphaValid) {
      warnings.push({ code: "INVALID_COLOR_CHANNEL", path, message: "HSL saturation, lightness, or alpha was out of range; default color used." });
      return fallback;
    }
  }
  return result;
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
  const out = [];
  let quote = null, escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      out.push(c);
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out.push(c); continue; }
    if (c === ",") {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === "}" || s[j] === "]") continue;
    }
    out.push(c);
  }
  s = out.join("");
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, '$1"$2"$3');
  s = s.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, body) =>
    `"${body.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`
  );
  s = s.replace(/(:\s*)([A-Za-z][A-Za-z0-9 _./-]*?)(\s*[,}\]])/g, (whole, before, value, after) => {
    const v = value.trim();
    if (!v || /^(?:true|false|null|undefined|NaN|Infinity)$/i.test(v) || /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(v)) return whole;
    if (v.startsWith('"') || v.startsWith("'")) return whole;
    return `${before}"${v.replace(/"/g, '\\"')}"${after}`;
  });
  s = s.replace(/\bundefined\b/g, "null").replace(/\bNaN\b/g, "null").replace(/\bInfinity\b/g, "null");
  // Narrow recovery for omitted commas before the next object key, quoted or bare.
  s = s.replace(/(["}\]\d]|true|false|null)\s+(?="[^"\n]+"\s*:)/g, "$1, ");
  s = s.replace(/(["}\]\d]|true|false|null)\s+([A-Za-z_$][\w$-]*)(\s*:)/g, '$1, "$2"$3');
  let stack = [], q = null, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      const expected = c === "}" ? "{" : "[";
      if (stack[stack.length - 1] === expected) stack.pop();
      else return s;
    }
  }
  if (q) {
    // Do not guess how a truncated string should continue; append a quote only at EOF.
    s += q;
  }
  if (stack.length && stack.length <= 24) while (stack.length) s += stack.pop() === "{" ? "}" : "]";
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
  const repaired = repairJsonLike(candidate);
  const attempts = [
    { text: candidate, label: "parsed original JSON" },
    { text: repaired, label: "repaired common JSON-like syntax and closed unambiguous containers" },
    { text: repaired.replace(/;\s*$/, ""), label: "removed trailing statement semicolon" },
    { text: repaired.replace(/^\s*;|;\s*$/g, ""), label: "removed stray outer semicolon" },
    { text: repaired.replace(/,\s*,/g, ","), label: "removed duplicate comma" }
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

const MATERIAL_PRESETS = Object.freeze({
  automotive_paint: { roughness: 0.2, metalness: 0.55, clearcoat: 1, clearcoatRoughness: 0.08 },
  brushed_metal: { roughness: 0.34, metalness: 0.92, proceduralTexture: "brushed_metal", normalScale: 0.18, anisotropy: 0.5 },
  polished_metal: { roughness: 0.12, metalness: 1 },
  stainless_steel: { roughness: 0.28, metalness: 0.95, proceduralTexture: "brushed_metal", normalScale: 0.12, anisotropy: 0.35 },
  cast_iron: { roughness: 0.72, metalness: 0.78, proceduralTexture: "concrete", normalScale: 0.22 },
  glass: { roughness: 0.06, metalness: 0, transmission: 0.96, ior: 1.5, thickness: 0.15, transparent: true },
  rubber: { roughness: 0.88, metalness: 0, proceduralTexture: "rubber", normalScale: 0.15 },
  leather: { roughness: 0.78, metalness: 0, sheen: 0.22, proceduralTexture: "leather", normalScale: 0.12 },
  fabric: { roughness: 0.9, metalness: 0, sheen: 0.12, proceduralTexture: "fabric", normalScale: 0.18 },
  wood: { roughness: 0.62, metalness: 0, proceduralTexture: "wood", normalScale: 0.1 },
  ceramic: { roughness: 0.22, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.15 },
  concrete: { roughness: 0.92, metalness: 0, proceduralTexture: "concrete", normalScale: 0.22 },
  carbon_fiber: { roughness: 0.3, metalness: 0.42, clearcoat: 0.55, proceduralTexture: "carbon_fiber", normalScale: 0.08 },
  plastic: { roughness: 0.36, metalness: 0 },
  emissive: { roughness: 0.35, metalness: 0, emissiveIntensity: 1 }
});

function normalizeMaterial(raw, index, seen, warnings) {
  const path = `materials[${index}]`;
  const keys = ["id", "name", "color", "roughness", "metalness", "opacity", "transparent", "wireframe", "side", "emissive", "emissiveIntensity", "clearcoat", "clearcoatRoughness", "sheen", "sheenRoughness", "sheenColor", "specularIntensity", "specularColor", "ior", "transmission", "thickness", "attenuationColor", "attenuationDistance", "envMapIntensity", "flatShading", "depthWrite", "depthTest", "alphaTest", "vertexColors", "preset", "proceduralTexture", "normalFilter", "textureScale", "normalScale", "roughnessVariation", "grainScale", "seed", "anisotropy", "anisotropyRotation"];
  const obj = safeObject(raw, keys, warnings, path);
  const id = stableId(obj.id, `material_${index + 1}`, seen);
  const presetName = cleanString(obj.preset, "", 40).toLowerCase();
  const preset = MATERIAL_PRESETS[presetName] || {};
  if (presetName && !MATERIAL_PRESETS[presetName]) warnings.push({ code: "UNKNOWN_MATERIAL_PRESET", path: `${path}.preset`, message: `Unknown material preset '${presetName}'; explicit material values and safe defaults were used.` });
  const value = (key, fallback) => obj[key] !== undefined ? obj[key] : (preset[key] !== undefined ? preset[key] : fallback);
  const opacity = num(value("opacity", 1), 1, 0, 1, warnings, `${path}.opacity`);
  const side = ["front", "back", "double"].includes(obj.side) ? obj.side : "front";
  const textureKinds = new Set(["wood", "leather", "fabric", "brushed_metal", "carbon_fiber", "concrete", "rubber", "noise"]);
  const requestedTexture = cleanString(value("proceduralTexture", ""), "", 40).toLowerCase();
  if (requestedTexture && !textureKinds.has(requestedTexture)) warnings.push({ code: "UNKNOWN_PROCEDURAL_TEXTURE", path: `${path}.proceduralTexture`, message: `Unknown procedural texture '${requestedTexture}' was ignored.` });
  return {
    id,
    name: cleanString(obj.name, id, 100),
    preset: presetName || null,
    color: color(obj.color, "#b8c4d6", warnings, `${path}.color`),
    roughness: num(value("roughness", 0.65), 0.65, 0, 1, warnings, `${path}.roughness`),
    metalness: num(value("metalness", 0), 0, 0, 1, warnings, `${path}.metalness`),
    opacity,
    transparent: Boolean(value("transparent", false)) || opacity < 1 || num(value("transmission", 0), 0, 0, 1, [], `${path}.transmission`) > 0.01,
    wireframe: Boolean(obj.wireframe),
    side,
    emissive: color(obj.emissive, "#000000", warnings, `${path}.emissive`),
    emissiveIntensity: num(value("emissiveIntensity", 0), 0, 0, 10, warnings, `${path}.emissiveIntensity`),
    clearcoat: num(value("clearcoat", 0), 0, 0, 1, warnings, `${path}.clearcoat`),
    clearcoatRoughness: num(value("clearcoatRoughness", 0.1), 0.1, 0, 1, warnings, `${path}.clearcoatRoughness`),
    sheen: num(value("sheen", 0), 0, 0, 1, warnings, `${path}.sheen`),
    sheenRoughness: num(value("sheenRoughness", 0.5), 0.5, 0, 1, warnings, `${path}.sheenRoughness`),
    sheenColor: color(obj.sheenColor, "#ffffff", warnings, `${path}.sheenColor`),
    specularIntensity: num(value("specularIntensity", 1), 1, 0, 1, warnings, `${path}.specularIntensity`),
    specularColor: color(obj.specularColor, "#ffffff", warnings, `${path}.specularColor`),
    ior: num(value("ior", 1.5), 1.5, 1, 2.333, warnings, `${path}.ior`),
    transmission: num(value("transmission", 0), 0, 0, 1, warnings, `${path}.transmission`),
    thickness: num(value("thickness", 0), 0, 0, MAX_DIMENSION, warnings, `${path}.thickness`),
    attenuationColor: color(obj.attenuationColor, "#ffffff", warnings, `${path}.attenuationColor`),
    attenuationDistance: num(value("attenuationDistance", 0), 0, 0, MAX_DIMENSION, warnings, `${path}.attenuationDistance`),
    envMapIntensity: num(obj.envMapIntensity, 1, 0, 100, warnings, `${path}.envMapIntensity`),
    flatShading: Boolean(obj.flatShading),
    depthWrite: obj.depthWrite !== false,
    depthTest: obj.depthTest !== false,
    alphaTest: num(obj.alphaTest, 0, 0, 1, warnings, `${path}.alphaTest`),
    vertexColors: Boolean(obj.vertexColors),
    proceduralTexture: textureKinds.has(requestedTexture) ? requestedTexture : null,
    normalFilter: cleanString(obj.normalFilter, "scharr_3x3", 40).toLowerCase(),
    textureScale: num(obj.textureScale, 1, 0.01, 100, warnings, `${path}.textureScale`),
    normalScale: num(value("normalScale", 0.15), 0.15, 0, 4, warnings, `${path}.normalScale`),
    roughnessVariation: num(obj.roughnessVariation, 0.08, 0, 1, warnings, `${path}.roughnessVariation`),
    grainScale: num(obj.grainScale, 1, 0.01, 100, warnings, `${path}.grainScale`),
    seed: Math.round(num(obj.seed, 137, 0, 2_147_483_647, warnings, `${path}.seed`)),
    anisotropy: num(value("anisotropy", 0), 0, 0, 1, warnings, `${path}.anisotropy`),
    anisotropyRotation: num(value("anisotropyRotation", 0), 0, -Math.PI * 2, Math.PI * 2, warnings, `${path}.anisotropyRotation`)
  };
}

/* --------------------------------------------------------------------------
 * V4 procedural geometry additions
 * - Centripetal Catmull-Rom + double-reflection rotation-minimizing frames
 * - Declarative SDF CSG tree + bounded regularized-QEF dual contouring
 * The kernels are deterministic, dependency-free and never evaluate code.
 * -------------------------------------------------------------------------- */
export function evalCentripetalCatmullRom(controlPoints, numSamples = 64, closed = false) {
  const n = controlPoints.length;
  if (n < 2) throw new Error("Spline requires at least 2 control points.");
  if (n === 2) {
    return Array.from({ length: numSamples + 1 }, (_, i) => {
      const t = i / numSamples;
      return [
        controlPoints[0][0] * (1 - t) + controlPoints[1][0] * t,
        controlPoints[0][1] * (1 - t) + controlPoints[1][1] * t,
        controlPoints[0][2] * (1 - t) + controlPoints[1][2] * t
      ];
    });
  }
  const pts = closed
    ? [controlPoints[n - 1], ...controlPoints, controlPoints[0], controlPoints[1]]
    : [
        [2 * controlPoints[0][0] - controlPoints[1][0], 2 * controlPoints[0][1] - controlPoints[1][1], 2 * controlPoints[0][2] - controlPoints[1][2]],
        ...controlPoints,
        [2 * controlPoints[n - 1][0] - controlPoints[n - 2][0], 2 * controlPoints[n - 1][1] - controlPoints[n - 2][1], 2 * controlPoints[n - 1][2] - controlPoints[n - 2][2]]
      ];

  const segCount = pts.length - 3;
  const out = [];
  const knotDelta = (pA, pB) => Math.max(1e-5, Math.sqrt(Math.hypot(pB[0] - pA[0], pB[1] - pA[1], pB[2] - pA[2])));

  for (let s = 0; s <= numSamples; s++) {
    const uGlobal = (s / numSamples) * segCount;
    const idx = Math.min(segCount - 1, Math.floor(uGlobal));
    const uLocal = uGlobal - idx;
    const p0 = pts[idx], p1 = pts[idx + 1], p2 = pts[idx + 2], p3 = pts[idx + 3];
    const t0 = 0, t1 = t0 + knotDelta(p0, p1), t2 = t1 + knotDelta(p1, p2), t3 = t2 + knotDelta(p2, p3);
    const t = t1 + uLocal * (t2 - t1);

    const lerp = (a, b, ta, tb) => {
      const denom = tb - ta;
      if (Math.abs(denom) < 1e-10) return a;
      const wA = (tb - t) / denom, wB = (t - ta) / denom;
      return [a[0] * wA + b[0] * wB, a[1] * wA + b[1] * wB, a[2] * wA + b[2] * wB];
    };
    const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
    const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
    out.push(lerp(B1, B2, t1, t2));
  }
  return out;
}

/**
 * Computes O(h^4) Rotation-Minimizing Frames (Bishop Frames) via Wang et al. Double Reflection.
 */
export function computeBishopFramesDoubleReflection(points, closed = false, twistRadians = 0) {
  const n = points.length;
  const tangents = new Array(n);
  const arcLengths = new Float64Array(n);
  let totalLength = 0;

  for (let i = 0; i < n; i++) {
    if (i > 0) {
      totalLength += Math.hypot(
        points[i][0] - points[i - 1][0],
        points[i][1] - points[i - 1][1],
        points[i][2] - points[i - 1][2]
      );
      arcLengths[i] = totalLength;
    }
    const prev = closed ? points[(i - 1 + n - 1) % (n - 1)] : points[Math.max(0, i - 1)];
    const next = closed ? points[(i + 1) % (n - 1)] : points[Math.min(n - 1, i + 1)];
    let tx = next[0] - prev[0], ty = next[1] - prev[1], tz = next[2] - prev[2];
    const len = Math.hypot(tx, ty, tz) || 1;
    tangents[i] = [tx / len, ty / len, tz / len];
  }

  // Initial orthonormal frame U_0 = (R_0, S_0, T_0)
  const T0 = tangents[0];
  const ax = Math.abs(T0[0]), ay = Math.abs(T0[1]), az = Math.abs(T0[2]);
  const ref = ax <= ay && ax <= az ? [1, 0, 0] : (ay <= az ? [0, 1, 0] : [0, 0, 1]);
  let rx = T0[1] * ref[2] - T0[2] * ref[1];
  let ry = T0[2] * ref[0] - T0[0] * ref[2];
  let rz = T0[0] * ref[1] - T0[1] * ref[0];
  const rLen = Math.hypot(rx, ry, rz) || 1;
  rx /= rLen; ry /= rLen; rz /= rLen;

  const normals = new Array(n);
  const binormals = new Array(n);
  normals[0] = [rx, ry, rz];
  binormals[0] = [
    T0[1] * rz - T0[2] * ry,
    T0[2] * rx - T0[0] * rz,
    T0[0] * ry - T0[1] * rx
  ];

  // Double Reflection propagation step (Wang et al. 2008)
  for (let i = 0; i < n - 1; i++) {
    const xi = points[i], xi1 = points[i + 1];
    const Ti = tangents[i], Ti1 = tangents[i + 1];
    const Ri = normals[i];

    const v1x = xi1[0] - xi[0], v1y = xi1[1] - xi[1], v1z = xi1[2] - xi[2];
    const c1 = v1x * v1x + v1y * v1y + v1z * v1z;
    if (c1 < 1e-18) {
      normals[i + 1] = [...Ri];
      binormals[i + 1] = [...binormals[i]];
      continue;
    }
    const dotV1R = (2 / c1) * (v1x * Ri[0] + v1y * Ri[1] + v1z * Ri[2]);
    const rLx = Ri[0] - dotV1R * v1x, rLy = Ri[1] - dotV1R * v1y, rLz = Ri[2] - dotV1R * v1z;

    const dotV1T = (2 / c1) * (v1x * Ti[0] + v1y * Ti[1] + v1z * Ti[2]);
    const tLx = Ti[0] - dotV1T * v1x, tLy = Ti[1] - dotV1T * v1y, tLz = Ti[2] - dotV1T * v1z;

    const v2x = Ti1[0] - tLx, v2y = Ti1[1] - tLy, v2z = Ti1[2] - tLz;
    const c2 = v2x * v2x + v2y * v2y + v2z * v2z;
    let rNextX = rLx, rNextY = rLy, rNextZ = rLz;
    if (c2 > 1e-18) {
      const dotV2RL = (2 / c2) * (v2x * rLx + v2y * rLy + v2z * rLz);
      rNextX = rLx - dotV2RL * v2x;
      rNextY = rLy - dotV2RL * v2y;
      rNextZ = rLz - dotV2RL * v2z;
    }
    // Re-orthogonalize against Ti1 to prevent floating-point drift over thousands of segments
    const proj = rNextX * Ti1[0] + rNextY * Ti1[1] + rNextZ * Ti1[2];
    rNextX -= proj * Ti1[0]; rNextY -= proj * Ti1[1]; rNextZ -= proj * Ti1[2];
    const nl = Math.hypot(rNextX, rNextY, rNextZ) || 1;
    rNextX /= nl; rNextY /= nl; rNextZ /= nl;

    normals[i + 1] = [rNextX, rNextY, rNextZ];
    binormals[i + 1] = [
      Ti1[1] * rNextZ - Ti1[2] * rNextY,
      Ti1[2] * rNextX - Ti1[0] * rNextZ,
      Ti1[0] * rNextY - Ti1[1] * rNextX
    ];
  }

  // Closed-path holonomy seam correction + user twist distribution
  let seamAngle = twistRadians;
  if (closed) {
    const Rn = normals[n - 1], R0 = normals[0], S0 = binormals[0];
    const holonomy = Math.atan2(
      Rn[0] * S0[0] + Rn[1] * S0[1] + Rn[2] * S0[2],
      Rn[0] * R0[0] + Rn[1] * R0[1] + Rn[2] * R0[2]
    );
    seamAngle -= holonomy;
  }
  if (Math.abs(seamAngle) > 1e-9 && totalLength > 1e-9) {
    for (let i = 0; i < n; i++) {
      const phi = (arcLengths[i] / totalLength) * seamAngle;
      const ca = Math.cos(phi), sa = Math.sin(phi);
      const R = normals[i], S = binormals[i];
      normals[i] = [R[0] * ca + S[0] * sa, R[1] * ca + S[1] * sa, R[2] * ca + S[2] * sa];
      binormals[i] = [S[0] * ca - R[0] * sa, S[1] * ca - R[1] * sa, S[2] * ca - R[2] * sa];
    }
  }
  return { tangents, normals, binormals, arcLengths, totalLength };
}

/**
 * Builds a watertight, manifold swept/tapered tube using Double-Reflection Bishop Frames.
 */
export function buildFailsafeBishopSweepMesh(p = {}) {
  const rawPath = Array.isArray(p.path) ? p.path : [[0, 0, 0], [0, 1, 0]];
  const closed = Boolean(p.closed);
  const samples = Math.min(512, Math.max(8, Math.round(p.tubularSegments ?? rawPath.length * 4)));
  const points = rawPath.length > 2 && p.interpolate !== false
    ? evalCentripetalCatmullRom(rawPath, samples, closed)
    : rawPath;

  const radial = Math.min(64, Math.max(6, Math.round(p.radialSegments ?? 24)));
  const rStart = Math.max(1e-5, Number(p.radiusStart ?? p.radius ?? 0.1));
  const rEnd = Math.max(1e-5, Number(p.radiusEnd ?? p.radius ?? 0.1));
  const { tangents, normals, binormals, arcLengths, totalLength } = computeBishopFramesDoubleReflection(points, closed, Number(p.twist ?? 0));

  const vertices = [], uvs = [], indices = [], normalsOut = [];
  const ringStride = radial + 1;

  for (let i = 0; i < points.length; i++) {
    const vCoord = totalLength > 1e-9 ? arcLengths[i] / totalLength : i / (points.length - 1);
    const r = rStart + (rEnd - rStart) * vCoord;
    const P = points[i], R = normals[i], S = binormals[i];
    for (let j = 0; j <= radial; j++) {
      const uCoord = j / radial;
      const theta = uCoord * Math.PI * 2;
      const ct = Math.cos(theta), st = Math.sin(theta);
      const nx = R[0] * ct + S[0] * st;
      const ny = R[1] * ct + S[1] * st;
      const nz = R[2] * ct + S[2] * st;
      vertices.push(P[0] + r * nx, P[1] + r * ny, P[2] + r * nz);
      normalsOut.push(nx, ny, nz);
      uvs.push(uCoord, vCoord);
    }
  }

  for (let i = 0; i < points.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * ringStride + j, b = a + ringStride;
      indices.push(a, b + 1, b, a, a + 1, b + 1);
    }
  }

  // Watertight planar end-capping with split crease normals for open tubes
  if (!closed && p.capEnds !== false) {
    const addCap = (ringIndex, isStart) => {
      const P = points[ringIndex], T = tangents[ringIndex], R = normals[ringIndex], S = binormals[ringIndex];
      const r = isStart ? rStart : rEnd;
      const capNormal = isStart ? [-T[0], -T[1], -T[2]] : [T[0], T[1], T[2]];
      const centerIdx = vertices.length / 3;
      vertices.push(P[0], P[1], P[2]);
      normalsOut.push(...capNormal);
      uvs.push(0.5, 0.5);

      const ringStartIdx = vertices.length / 3;
      for (let j = 0; j <= radial; j++) {
        const theta = (j / radial) * Math.PI * 2;
        const ct = Math.cos(theta), st = Math.sin(theta);
        const nx = R[0] * ct + S[0] * st, ny = R[1] * ct + S[1] * st, nz = R[2] * ct + S[2] * st;
        vertices.push(P[0] + r * nx, P[1] + r * ny, P[2] + r * nz);
        normalsOut.push(...capNormal);
        uvs.push(0.5 + 0.5 * ct, 0.5 + 0.5 * st);
      }
      for (let j = 0; j < radial; j++) {
        if (isStart) indices.push(centerIdx, ringStartIdx + j + 1, ringStartIdx + j);
        else indices.push(centerIdx, ringStartIdx + j, ringStartIdx + j + 1);
      }
    };
    addCap(0, true);
    addCap(points.length - 1, false);
  }

  return {
    vertices,
    indices,
    normals: normalsOut,
    uvs,
    recipe: "sweep_bishop",
    topology: "closed-manifold-solid"
  };
}

export function evaluateSDFNode(node, px, py, pz, depth = 0) {
  if (!node || depth > 32) return 1e6;
  // Apply optional local translation
  if (node.position) {
    px -= node.position[0] || 0;
    py -= node.position[1] || 0;
    pz -= node.position[2] || 0;
  }
  // Domain operators
  if (node.op === "twist") {
    const k = Number(node.rate ?? 1.0);
    const c = Math.cos(k * py), s = Math.sin(k * py);
    const nx = c * px - s * pz, nz = s * px + c * pz;
    return evaluateSDFNode(node.child, nx, py, nz, depth + 1) * 0.75; // Lipschitz safety factor
  }
  if (node.op === "repeat_polar") {
    const count = Math.max(1, Math.round(node.count || 4));
    const sector = (Math.PI * 2) / count;
    const angle = Math.atan2(pz, px);
    const r = Math.hypot(px, pz);
    const aMod = ((angle + sector * 0.5) % sector + sector) % sector - sector * 0.5;
    return evaluateSDFNode(node.child, r * Math.cos(aMod), py, r * Math.sin(aMod), depth + 1);
  }
  if (node.op === "round") return evaluateSDFNode(node.child, px, py, pz, depth + 1) - Number(node.radius ?? node.amount ?? 0);
  if (node.op === "onion") return Math.abs(evaluateSDFNode(node.child, px, py, pz, depth + 1)) - Number(node.thickness ?? node.amount ?? 0.05);
  if (node.op === "scale") {
    const sc = Array.isArray(node.value) ? node.value : [node.value ?? 1, node.value ?? 1, node.value ?? 1];
    const sx = Math.max(1e-4, Math.abs(Number(sc[0]) || 1)), sy = Math.max(1e-4, Math.abs(Number(sc[1]) || 1)), sz = Math.max(1e-4, Math.abs(Number(sc[2]) || 1));
    return evaluateSDFNode(node.child, px / sx, py / sy, pz / sz, depth + 1) * Math.min(sx, sy, sz);
  }
  if (node.op === "rotate") {
    const r = Array.isArray(node.rotation) ? node.rotation : [0, 0, 0];
    const cx = Math.cos(-(r[0] || 0)), sx = Math.sin(-(r[0] || 0));
    const cy = Math.cos(-(r[1] || 0)), sy = Math.sin(-(r[1] || 0));
    const cz = Math.cos(-(r[2] || 0)), sz = Math.sin(-(r[2] || 0));
    let y1 = py * cx - pz * sx, z1 = py * sx + pz * cx;
    let x2 = px * cy + z1 * sy, z2 = -px * sy + z1 * cy;
    let x3 = x2 * cz - y1 * sz, y3 = x2 * sz + y1 * cz;
    return evaluateSDFNode(node.child, x3, y3, z2, depth + 1);
  }
  if (node.op === "translate") return evaluateSDFNode(node.child, px - (node.position?.[0] || 0), py - (node.position?.[1] || 0), pz - (node.position?.[2] || 0), depth + 1);
  // CSG Boolean & Smooth Blending Operators
  if (node.op === "union" || node.op === "smooth_union") {
    const d1 = evaluateSDFNode(node.a, px, py, pz, depth + 1);
    const d2 = evaluateSDFNode(node.b, px, py, pz, depth + 1);
    const k = Number(node.k ?? 0);
    if (k <= 1e-6) return Math.min(d1, d2);
    const h = Math.max(k - Math.abs(d1 - d2), 0) / k;
    return Math.min(d1, d2) - h * h * k * 0.25;
  }
  if (node.op === "subtract" || node.op === "smooth_subtract") {
    const d1 = evaluateSDFNode(node.a, px, py, pz, depth + 1);
    const d2 = evaluateSDFNode(node.b, px, py, pz, depth + 1);
    const k = Number(node.k ?? 0);
    if (k <= 1e-6) return Math.max(d1, -d2);
    const h = Math.max(k - Math.abs(d1 + d2), 0) / k;
    return Math.max(d1, -d2) + h * h * k * 0.25;
  }
  if (node.op === "intersect" || node.op === "smooth_intersect") {
    const d1 = evaluateSDFNode(node.a, px, py, pz, depth + 1);
    const d2 = evaluateSDFNode(node.b, px, py, pz, depth + 1);
    const k = Number(node.k ?? 0);
    if (k <= 1e-6) return Math.max(d1, d2);
    const h = Math.max(k - Math.abs(d1 - d2), 0) / k;
    return Math.max(d1, d2) + h * h * k * 0.25;
  }

  // Exact SDF Primitives
  let d = 1e6;
  switch (node.type) {
    case "sphere":
      d = Math.hypot(px, py, pz) - Number(node.radius ?? 0.5);
      break;
    case "box": {
      const s = node.size || [1, 1, 1];
      const qx = Math.abs(px) - s[0] * 0.5;
      const qy = Math.abs(py) - s[1] * 0.5;
      const qz = Math.abs(pz) - s[2] * 0.5;
      d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
      break;
    }
    case "cylinder": {
      const r = Number(node.radius ?? 0.5), h = Number(node.height ?? 1.0) * 0.5;
      const dx = Math.hypot(px, pz) - r, dy = Math.abs(py) - h;
      d = Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
      break;
    }
    case "capsule": {
      const a = node.a || [0, -0.5, 0], b = node.b || [0, 0.5, 0], r = Number(node.radius ?? 0.25);
      const pax = px - a[0], pay = py - a[1], paz = pz - a[2];
      const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
      const dotBA = bax * bax + bay * bay + baz * baz;
      const h = dotBA > 1e-12 ? Math.max(0, Math.min(1, (pax * bax + pay * bay + paz * baz) / dotBA)) : 0;
      d = Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - r;
      break;
    }
    default:
      d = Math.hypot(px, py, pz) - 0.5;
  }
  if (node.round) d -= Number(node.round);
  if (node.onion) d = Math.abs(d) - Number(node.onion);
  return d;
}

/**
 * 4-Tap Symmetric Tetrahedron Analytical Gradient Normal
 */
export function sdfTetrahedronNormal(rootNode, px, py, pz, eps = 1e-4) {
  const f0 = evaluateSDFNode(rootNode, px + eps, py - eps, pz - eps);
  const f1 = evaluateSDFNode(rootNode, px - eps, py - eps, pz + eps);
  const f2 = evaluateSDFNode(rootNode, px - eps, py + eps, pz - eps);
  const f3 = evaluateSDFNode(rootNode, px + eps, py + eps, pz + eps);
  const gx = f0 - f1 - f2 + f3;
  const gy = -f0 - f1 + f2 + f3;
  const gz = -f0 + f1 - f2 + f3;
  const len = Math.hypot(gx, gy, gz) || 1;
  return [gx / len, gy / len, gz / len];
}

/**
 * Tikhonov-Regularized 3x3 QEF Solver: minimizes sum_i (n_i . (x - p_i))^2 + lambda ||x - massPoint||^2
 */
function solveRegularizedQEF(intersections, normals, cellMin, cellMax, lambda = 0.015) {
  const k = intersections.length;
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < k; i++) {
    mx += intersections[i][0]; my += intersections[i][1]; mz += intersections[i][2];
  }
  mx /= k; my /= k; mz /= k;

  // Normal equations: (A^T A + lambda I) delta = A^T r, where r_i = n_i . (p_i - m)
  let a00 = lambda, a01 = 0, a02 = 0, a11 = lambda, a12 = 0, a22 = lambda;
  let b0 = 0, b1 = 0, b2 = 0;

  for (let i = 0; i < k; i++) {
    const nx = normals[i][0], ny = normals[i][1], nz = normals[i][2];
    const rx = intersections[i][0] - mx, ry = intersections[i][1] - my, rz = intersections[i][2] - mz;
    const rhs = nx * rx + ny * ry + nz * rz;
    a00 += nx * nx; a01 += nx * ny; a02 += nx * nz;
    a11 += ny * ny; a12 += ny * nz; a22 += nz * nz;
    b0 += nx * rhs; b1 += ny * rhs; b2 += nz * rhs;
  }

  // Symmetric 3x3 determinant & Cramer inversion
  const c00 = a11 * a22 - a12 * a12;
  const c01 = a02 * a12 - a01 * a22;
  const c02 = a01 * a12 - a02 * a11;
  const c11 = a00 * a22 - a02 * a02;
  const c12 = a01 * a02 - a00 * a12;
  const c22 = a00 * a11 - a01 * a01;
  const det = a00 * c00 + a01 * c01 + a02 * c02;

  if (Math.abs(det) < 1e-12) return [mx, my, mz];
  const invDet = 1.0 / det;
  const vx = mx + (c00 * b0 + c01 * b1 + c02 * b2) * invDet;
  const vy = my + (c01 * b0 + c11 * b1 + c12 * b2) * invDet;
  const vz = mz + (c02 * b0 + c12 * b1 + c22 * b2) * invDet;

  // Clamp strictly to voxel cell bounds to prevent self-intersecting spikes
  return [
    Math.max(cellMin[0], Math.min(cellMax[0], vx)),
    Math.max(cellMin[1], Math.min(cellMax[1], vy)),
    Math.max(cellMin[2], Math.min(cellMax[2], vz))
  ];
}

const SDF_PRIMITIVE_TYPES = new Set(["sphere", "box", "cylinder", "capsule"]);
const SDF_OPERATORS = new Set(["union", "subtract", "intersect", "smooth_union", "smooth_subtract", "smooth_intersect", "twist", "repeat_polar", "round", "onion", "translate", "scale", "rotate"]);
function validateSDFTree(root) {
  const state = { nodes: 0 };
  const visit = (node, depth) => {
    if (!isObject(node)) throw new Error("Every SDF node must be a plain declarative object.");
    if (depth > 24) throw new Error("SDF tree exceeded the 24-level depth limit.");
    if (++state.nodes > 256) throw new Error("SDF tree exceeded the 256-node compilation limit.");
    if (node.op !== undefined) {
      if (!SDF_OPERATORS.has(node.op)) throw new Error(`Unsupported SDF operator '${String(node.op).slice(0, 48)}'.`);
      if (["union", "subtract", "intersect", "smooth_union", "smooth_subtract", "smooth_intersect"].includes(node.op)) {
        visit(node.a, depth + 1); visit(node.b, depth + 1);
      } else if (["twist", "repeat_polar", "round", "onion", "translate", "scale", "rotate"].includes(node.op)) visit(node.child, depth + 1);
    } else if (!SDF_PRIMITIVE_TYPES.has(node.type)) {
      throw new Error(`Unsupported SDF primitive type '${String(node.type)}'.`);
    }
    for (const k of ["position", "size", "a", "b", "rotation", "value"]) {
      const v = node[k];
      if (v !== undefined && Array.isArray(v) && v.some(n => !finite(n))) throw new Error(`SDF node field '${k}' must contain finite numbers.`);
    }
    for (const k of ["radius", "height", "round", "onion", "k", "rate", "count", "thickness"]) {
      if (node[k] !== undefined && !finite(node[k])) throw new Error(`SDF node field '${k}' must be finite.`);
    }
  };
  visit(root, 0);
  return state.nodes;
}

function sealSDFBoundaryLoops(root, vertices, indices, normals, uvs, bMin, bMax) {
  const directed = new Map(), adjacency = new Map(), edgeCount = new Map();
  const edgeKey = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [indices[i], indices[i + 1], indices[i + 2]];
    for (let e = 0; e < 3; e++) {
      const a = tri[e], b = tri[(e + 1) % 3], key = edgeKey(a, b);
      edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
      if (!directed.has(key)) directed.set(key, { a, b });
    }
  }
  for (const [key, count] of edgeCount) if (count === 1) {
    const edge = directed.get(key);
    if (!adjacency.has(edge.a)) adjacency.set(edge.a, []);
    if (!adjacency.has(edge.b)) adjacency.set(edge.b, []);
    adjacency.get(edge.a).push(edge.b); adjacency.get(edge.b).push(edge.a);
  }
  const used = new Set();
  for (const [start, neighbors] of adjacency) {
    for (const first of neighbors) {
      const firstKey = edgeKey(start, first);
      if (used.has(firstKey)) continue;
      if (neighbors.length !== 2 || (adjacency.get(first)?.length || 0) !== 2) { used.add(firstKey); continue; }
      const loop = [start]; let previous = start, current = first, guard = 0;
      used.add(firstKey);
      while (current !== start && guard++ <= adjacency.size + 2) {
        loop.push(current);
        const ns = adjacency.get(current) || [];
        if (ns.length !== 2) break;
        const next = ns[0] === previous ? ns[1] : ns[0];
        const k = edgeKey(current, next);
        if (used.has(k) && next !== start) break;
        used.add(k); previous = current; current = next;
      }
      if (current !== start || loop.length < 3) continue;
      const firstDirection = directed.get(firstKey);
      if (firstDirection && !(firstDirection.a === loop[0] && firstDirection.b === loop[1])) loop.reverse();
      let cx = 0, cy = 0, cz = 0;
      for (const vi of loop) { cx += vertices[vi * 3]; cy += vertices[vi * 3 + 1]; cz += vertices[vi * 3 + 2]; }
      cx /= loop.length; cy /= loop.length; cz /= loop.length;
      const ci = vertices.length / 3;
      vertices.push(cx, cy, cz);
      const n = sdfTetrahedronNormal(root, cx, cy, cz, Math.max(1e-5, Math.hypot(bMax[0]-bMin[0], bMax[1]-bMin[1], bMax[2]-bMin[2]) * 1e-4));
      normals.push(n[0], n[1], n[2]);
      const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
      if (ax >= ay && ax >= az) uvs.push(cz, cy); else if (ay >= az) uvs.push(cx, cz); else uvs.push(cx, cy);
      for (let i = 0; i < loop.length; i++) indices.push(ci, loop[(i + 1) % loop.length], loop[i]);
      if (indices.length > MAX_MESH_INDICES) throw new Error("SDF boundary sealing exceeded the configured index limit.");
    }
  }
}

/**
 * Dual Contouring Polygonizer with Analytical Normals & Triplanar UVs
 */
export function polygonizeSDFDualContouring(sdfSpec = {}) {
  const res = Math.min(64, Math.max(16, Math.round(sdfSpec.resolution ?? 48)));
  const bMin = sdfSpec.bounds?.[0] || [-1.2, -1.2, -1.2];
  const bMax = sdfSpec.bounds?.[1] || [1.2, 1.2, 1.2];
  const root = sdfSpec.root;
  validateSDFTree(root);
  if (!Array.isArray(bMin) || !Array.isArray(bMax) || bMin.length < 3 || bMax.length < 3 || !bMin.slice(0, 3).every(finite) || !bMax.slice(0, 3).every(finite) || [0, 1, 2].some(i => bMax[i] <= bMin[i])) throw new Error("SDF bounds must be valid finite min/max XYZ vectors.");

  const nx = res + 1, ny = res + 1, nz = res + 1;
  const dx = (bMax[0] - bMin[0]) / res;
  const dy = (bMax[1] - bMin[1]) / res;
  const dz = (bMax[2] - bMin[2]) / res;

  const grid = new Float32Array(nx * ny * nz);
  const idx3 = (x, y, z) => (z * ny + y) * nx + x;

  for (let z = 0; z < nz; z++) {
    const pz = bMin[2] + z * dz;
    for (let y = 0; y < ny; y++) {
      const py = bMin[1] + y * dy;
      for (let x = 0; x < nx; x++) {
        grid[idx3(x, y, z)] = evaluateSDFNode(root, bMin[0] + x * dx, py, pz);
      }
    }
  }

  const cellVertIndex = new Int32Array(res * res * res).fill(-1);
  const cellIdx = (x, y, z) => (z * res + y) * res + x;
  const vertices = [], normals = [], uvs = [], indices = [];

  const edgePairs = [
    [0,0,0, 1,0,0], [0,1,0, 1,1,0], [0,0,1, 1,0,1], [0,1,1, 1,1,1],
    [0,0,0, 0,1,0], [1,0,0, 1,1,0], [0,0,1, 0,1,1], [1,0,1, 1,1,1],
    [0,0,0, 0,0,1], [1,0,0, 1,0,1], [0,1,0, 0,1,1], [1,1,0, 1,1,1]
  ];

  // Pass 1: Solve QEF per active cell
  for (let z = 0; z < res; z++) {
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const pts = [], nrms = [];
        for (let e = 0; e < 12; e++) {
          const ep = edgePairs[e];
          const d0 = grid[idx3(x + ep[0], y + ep[1], z + ep[2])];
          const d1 = grid[idx3(x + ep[3], y + ep[4], z + ep[5])];
          if ((d0 < 0) !== (d1 < 0)) {
            let t = d0 / (d0 - d1);
            const p0x = bMin[0] + (x + ep[0]) * dx, p0y = bMin[1] + (y + ep[1]) * dy, p0z = bMin[2] + (z + ep[2]) * dz;
            const p1x = bMin[0] + (x + ep[3]) * dx, p1y = bMin[1] + (y + ep[4]) * dy, p1z = bMin[2] + (z + ep[5]) * dz;
            // 3-step binary/secant root refinement along edge
            let a = 0, b = 1, fa = d0;
            for (let iter = 0; iter < 3; iter++) {
              const mid = 0.5 * (a + b);
              const fm = evaluateSDFNode(root, p0x + (p1x - p0x) * mid, p0y + (p1y - p0y) * mid, p0z + (p1z - p0z) * mid);
              if ((fa < 0) === (fm < 0)) { a = mid; fa = fm; } else { b = mid; }
              t = 0.5 * (a + b);
            }
            const ix = p0x + (p1x - p0x) * t, iy = p0y + (p1y - p0y) * t, iz = p0z + (p1z - p0z) * t;
            pts.push([ix, iy, iz]);
            nrms.push(sdfTetrahedronNormal(root, ix, iy, iz));
          }
        }
        if (pts.length > 0) {
          if (vertices.length / 3 >= 60000) throw new Error("SDF polygonization exceeded the 60000-vertex safety cap; lower resolution or simplify the field.");
          const cMin = [bMin[0] + x * dx, bMin[1] + y * dy, bMin[2] + z * dz];
          const cMax = [cMin[0] + dx, cMin[1] + dy, cMin[2] + dz];
          const v = solveRegularizedQEF(pts, nrms, cMin, cMax);
          const n = sdfTetrahedronNormal(root, v[0], v[1], v[2]);
          cellVertIndex[cellIdx(x, y, z)] = vertices.length / 3;
          vertices.push(v[0], v[1], v[2]);
          normals.push(n[0], n[1], n[2]);
          // Dominant-axis box UV projection
          const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
          if (ax >= ay && ax >= az) uvs.push(v[2], v[1]);
          else if (ay >= az) uvs.push(v[0], v[2]);
          else uvs.push(v[0], v[1]);
        }
      }
    }
  }

  // Pass 2: Connect 4 dual vertices around each interior sign-changing edge
  const emitQuad = (v0, v1, v2, v3, flip) => {
    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) return;
    if (flip) indices.push(v0, v1, v2, v0, v2, v3);
    else indices.push(v0, v2, v1, v0, v3, v2);
  };

  for (let z = 1; z < res; z++) {
    for (let y = 1; y < res; y++) {
      for (let x = 1; x < res; x++) {
        const d0 = grid[idx3(x, y, z)];
        if (x < res) {
          const dX = grid[idx3(x + 1, y, z)];
          if ((d0 < 0) !== (dX < 0)) {
            emitQuad(
              cellVertIndex[cellIdx(x, y - 1, z - 1)],
              cellVertIndex[cellIdx(x, y, z - 1)],
              cellVertIndex[cellIdx(x, y, z)],
              cellVertIndex[cellIdx(x, y - 1, z)],
              d0 < 0
            );
          }
        }
        if (y < res) {
          const dY = grid[idx3(x, y + 1, z)];
          if ((d0 < 0) !== (dY < 0)) {
            emitQuad(
              cellVertIndex[cellIdx(x - 1, y, z - 1)],
              cellVertIndex[cellIdx(x - 1, y, z)],
              cellVertIndex[cellIdx(x, y, z)],
              cellVertIndex[cellIdx(x, y, z - 1)],
              d0 < 0
            );
          }
        }
        if (z < res) {
          const dZ = grid[idx3(x, y, z + 1)];
          if ((d0 < 0) !== (dZ < 0)) {
            emitQuad(
              cellVertIndex[cellIdx(x - 1, y - 1, z)],
              cellVertIndex[cellIdx(x, y - 1, z)],
              cellVertIndex[cellIdx(x, y, z)],
              cellVertIndex[cellIdx(x - 1, y, z)],
              d0 < 0
            );
          }
        }
      }
    }
  }

  // Resolve small open loops created by ambiguous multi-sheet cells. This is a bounded
  // fallback cap, not a replacement for an exact manifold boolean kernel.
  sealSDFBoundaryLoops(root, vertices, indices, normals, uvs, bMin, bMax);
  return { vertices, indices, normals, uvs, recipe: "sdf_dual_contouring", topology: "closed-surface" };
}

// ---------------------- deterministic procedural mesh kernel ----------------------
function meshClamp(value, fallback, min, max) {
  return clamp(finite(value) ? value : fallback, min, max);
}
function flatNumberArray(value, maxValues, allowTriples = false) {
  if (!Array.isArray(value)) return null;
  let arr = value;
  if (allowTriples && arr.length && Array.isArray(arr[0])) {
    arr = [];
    for (const tuple of value) {
      if (!Array.isArray(tuple) || tuple.length < 3) return null;
      arr.push(tuple[0], tuple[1], tuple[2]);
    }
  }
  if (arr.length > maxValues || !arr.every(finite)) return null;
  return arr.slice();
}
function cross2(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
function polygonArea2(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) { const p = points[i], q = points[(i + 1) % points.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
function pointInTriangle2(p, a, b, c) {
  const d1 = cross2(p, a, b), d2 = cross2(p, b, c), d3 = cross2(p, c, a);
  const neg = d1 < -1e-10 || d2 < -1e-10 || d3 < -1e-10;
  const pos = d1 > 1e-10 || d2 > 1e-10 || d3 > 1e-10;
  return !(neg && pos);
}
function triangulateSimplePolygon(points) {
  if (points.length < 3 || points.length > MAX_PROFILE_POINTS) throw new Error("Profile needs 3 to 512 points.");
  let pts = points.map(p => [p[0], p[1]]);
  if (pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-10) pts.pop();
  if (pts.length < 3) throw new Error("Profile has fewer than three distinct points.");
  for (let i = 0; i < pts.length; i++) {
    if (Math.hypot(pts[i][0] - pts[(i + 1) % pts.length][0], pts[i][1] - pts[(i + 1) % pts.length][1]) < 1e-10) throw new Error("Profile contains a zero-length edge.");
  }
  const area = polygonArea2(pts);
  if (Math.abs(area) < 1e-10) throw new Error("Profile area is zero.");
  if (area < 0) pts.reverse();
  // Reject self-intersections rather than producing plausible-looking broken topology.
  const orient = (a, b, c) => Math.sign(cross2(a, b, c));
  const intersects = (a, b, c, d) => {
    const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
    return o1 !== o2 && o3 !== o4;
  };
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const i2 = (i + 1) % pts.length, j2 = (j + 1) % pts.length;
    if (i === j || i2 === j || j2 === i) continue;
    if (intersects(pts[i], pts[i2], pts[j], pts[j2])) throw new Error("Profile self-intersects; a valid simple polygon is required.");
  }
  const remaining = pts.map((_, i) => i), triangles = [];
  let guard = 0;
  while (remaining.length > 3 && guard++ < pts.length * pts.length) {
    let cut = false;
    for (let i = 0; i < remaining.length; i++) {
      const ia = remaining[(i + remaining.length - 1) % remaining.length], ib = remaining[i], ic = remaining[(i + 1) % remaining.length];
      if (cross2(pts[ia], pts[ib], pts[ic]) <= 1e-10) continue;
      let contains = false;
      for (const k of remaining) { if (k !== ia && k !== ib && k !== ic && pointInTriangle2(pts[k], pts[ia], pts[ib], pts[ic])) { contains = true; break; } }
      if (contains) continue;
      triangles.push(ia, ib, ic); remaining.splice(i, 1); cut = true; break;
    }
    if (!cut) throw new Error("Could not triangulate profile reliably; simplify or repair the profile.");
  }
  if (remaining.length === 3) triangles.push(remaining[0], remaining[1], remaining[2]);
  return { points: pts, triangles };
}
function buildBeveledBoxMesh(p = {}) {
  const w = meshClamp(p.width, 1, MIN_DIMENSION, MAX_DIMENSION), h = meshClamp(p.height, 1, MIN_DIMENSION, MAX_DIMENSION), d = meshClamp(p.depth, 1, MIN_DIMENSION, MAX_DIMENSION);
  const maxB = Math.min(w, h, d) * 0.499;
  const b = meshClamp(p.bevel ?? p.bevelSize, Math.min(w, h, d) * 0.06, 1e-5, maxB);
  const seg = Math.round(meshClamp(p.segments ?? p.bevelSegments, 3, 1, 12));
  const half = [w / 2, h / 2, d / 2], inner = half.map(n => Math.max(1e-7, n - b));
  const faces = [
    { n: [1,0,0], u: [0,0,-1], v: [0,1,0], axis: 0 }, { n: [-1,0,0], u: [0,0,1], v: [0,1,0], axis: 0 },
    { n: [0,1,0], u: [1,0,0], v: [0,0,-1], axis: 1 }, { n: [0,-1,0], u: [1,0,0], v: [0,0,1], axis: 1 },
    { n: [0,0,1], u: [1,0,0], v: [0,1,0], axis: 2 }, { n: [0,0,-1], u: [-1,0,0], v: [0,1,0], axis: 2 }
  ];
  const vertices = [], normals = [], uvs = [], indices = [];
  for (const face of faces) {
    const base = vertices.length / 3;
    for (let j = 0; j <= seg; j++) for (let i = 0; i <= seg; i++) {
      const uAxis = face.u.findIndex(v => Math.abs(v) > 0.5);
      const vAxis = face.v.findIndex(v => Math.abs(v) > 0.5);
      const uu = (i / seg * 2 - 1) * half[uAxis];
      const vv = (j / seg * 2 - 1) * half[vAxis];
      let pt = [face.n[0] * half[face.axis] + face.u[0] * uu + face.v[0] * vv, face.n[1] * half[face.axis] + face.u[1] * uu + face.v[1] * vv, face.n[2] * half[face.axis] + face.u[2] * uu + face.v[2] * vv];
      const q = pt.map((n, axis) => clamp(n, -inner[axis], inner[axis]));
      let delta = pt.map((n, axis) => n - q[axis]);
      let len = Math.hypot(...delta);
      if (len < 1e-10) { delta = [...face.n]; len = 1; }
      const normal = delta.map(n => n / len);
      pt = q.map((n, axis) => n + normal[axis] * b);
      vertices.push(...pt); normals.push(...normal); uvs.push(i / seg, j / seg);
    }
    for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
      const a = base + j * (seg + 1) + i, bu = a + 1, bv = a + seg + 1, buv = bv + 1;
      indices.push(a, bu, buv, a, buv, bv);
    }
  }
  return { vertices, indices, normals, uvs, recipe: "beveled_box", topology: "closed-surface" };
}
function buildExtrudeMesh(p = {}) {
  const profile = Array.isArray(p.profile) ? p.profile : p.points;
  if (!Array.isArray(profile) || profile.length > MAX_PROFILE_POINTS) throw new Error("extrude recipe requires a 2D profile array of at most 512 points.");
  const parsed = profile.map((pt, i) => {
    if (!Array.isArray(pt) || pt.length < 2 || !finite(pt[0]) || !finite(pt[1])) throw new Error(`Profile point ${i} must be [x,y].`);
    return [clamp(pt[0], -MAX_DIMENSION, MAX_DIMENSION), clamp(pt[1], -MAX_DIMENSION, MAX_DIMENSION)];
  });
  const result = triangulateSimplePolygon(parsed), pts = result.points;
  const depth = meshClamp(p.depth ?? p.thickness, 1, MIN_DIMENSION, MAX_DIMENSION), half = depth / 2, n = pts.length;
  const vertices = [], uvs = [], indices = [];
  for (const z of [half, -half]) for (const [x, y] of pts) { vertices.push(x, y, z); uvs.push(x, y); }
  for (let i = 0; i < result.triangles.length; i += 3) {
    const a = result.triangles[i], b = result.triangles[i + 1], c = result.triangles[i + 2];
    indices.push(a, b, c, n + c, n + b, n + a);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, bi = n + i, bj = n + j;
    indices.push(bi, bj, j, bi, j, i);
  }
  return { vertices, indices, uvs, recipe: "extrude", topology: "closed-surface" };
}
function buildLatheMesh(p = {}) {
  const raw = Array.isArray(p.profile) ? p.profile : p.points;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_PROFILE_POINTS) throw new Error("lathe recipe requires a radius/height profile with 2 to 512 points.");
  const profile = raw.map((pt, i) => {
    if (!Array.isArray(pt) || pt.length < 2 || !finite(pt[0]) || !finite(pt[1]) || pt[0] < 0) throw new Error(`Lathe profile point ${i} must be [nonnegativeRadius,y].`);
    return [clamp(pt[0], MIN_DIMENSION, MAX_DIMENSION), clamp(pt[1], -MAX_DIMENSION, MAX_DIMENSION)];
  });
  const requested = Math.round(meshClamp(p.segments, 64, 8, 256));
  const seg = Math.max(8, Math.min(requested, Math.floor((MAX_MESH_VERTICES - 2) / profile.length) - 1));
  const vertices = [], uvs = [], indices = [];
  for (let j = 0; j < profile.length; j++) for (let i = 0; i <= seg; i++) {
    const a = i / seg * Math.PI * 2, [r, y] = profile[j];
    vertices.push(r * Math.cos(a), y, r * Math.sin(a)); uvs.push(i / seg, j / (profile.length - 1));
  }
  for (let j = 0; j < profile.length - 1; j++) for (let i = 0; i < seg; i++) {
    const a = j * (seg + 1) + i, b = a + seg + 1;
    indices.push(a, b, b + 1, a, b + 1, a + 1);
  }
  return { vertices, indices, uvs, recipe: "lathe", topology: "profile-surface" };
}
function buildSweepMesh(p = {}) {
  const built = buildFailsafeBishopSweepMesh({
    ...p,
    path: p.path,
    interpolate: p.interpolate !== false,
    capEnds: p.capEnds !== false
  });
  return { ...built, recipe: "sweep", topology: p.closed ? "closed-sweep" : "closed-manifold-solid" };
}

function buildGearMesh(p = {}) {
  const teeth = Math.round(meshClamp(p.teeth, 24, 6, 120));
  const outerR = meshClamp(p.outerRadius ?? p.radius, 1, MIN_DIMENSION, MAX_DIMENSION);
  const rootR = meshClamp(p.rootRadius, outerR * 0.82, MIN_DIMENSION, outerR * 0.999);
  const bore = meshClamp(p.boreRadius, outerR * 0.18, 0, rootR * 0.95);
  const depth = meshClamp(p.thickness ?? p.depth, outerR * 0.18, MIN_DIMENSION, MAX_DIMENSION), zf = depth / 2, zb = -depth / 2;
  const fractions = [0, 0.14, 0.22, 0.32, 0.68, 0.78, 0.86];
  const radii = [rootR, rootR, rootR, outerR, outerR, rootR, rootR];
  const angles = [];
  for (let t = 0; t < teeth; t++) for (let k = 0; k < fractions.length; k++) angles.push((t + fractions[k]) * Math.PI * 2 / teeth);
  const n = angles.length, hasBore = bore > 1e-8, vertices = [], uvs = [], indices = [];
  const pushRing = (z, radiusList) => {
    const base = vertices.length / 3;
    for (let i = 0; i < n; i++) {
      const r = typeof radiusList === "number" ? radiusList : radiusList[i % fractions.length];
      const a = angles[i];
      vertices.push(r * Math.cos(a), r * Math.sin(a), z);
      uvs.push(0.5 + Math.cos(a) * r / (2 * outerR), 0.5 + Math.sin(a) * r / (2 * outerR));
    }
    return base;
  };
  const fo = pushRing(zf, radii), fi = hasBore ? pushRing(zf, bore) : -1;
  const bo = pushRing(zb, radii), bi = hasBore ? pushRing(zb, bore) : -1;
  let frontCenter = -1, backCenter = -1;
  if (!hasBore) {
    frontCenter = vertices.length / 3; vertices.push(0,0,zf); uvs.push(0.5,0.5);
    backCenter = vertices.length / 3; vertices.push(0,0,zb); uvs.push(0.5,0.5);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (hasBore) {
      // Front and back annular faces preserve the through-bore as actual missing geometry.
      indices.push(fo+i, fo+j, fi+j, fo+i, fi+j, fi+i);
      indices.push(bo+i, bi+j, bo+j, bo+i, bi+i, bi+j);
      indices.push(bi+i, fi+j, bi+j, bi+i, fi+i, fi+j);
    } else {
      // A genuinely solid center is triangulated to a center vertex, not a tiny fake hole.
      indices.push(frontCenter, fo+i, fo+j);
      indices.push(backCenter, bo+j, bo+i);
    }
    // Outer wall, with normals facing away from the gear center.
    indices.push(bo+i, bo+j, fo+j, bo+i, fo+j, fo+i);
  }
  return { vertices, indices, uvs, recipe: "gear", topology: hasBore ? "closed-annular-solid" : "closed-solid-disc" };
}
function buildSpringMesh(p = {}) {
  const turns = meshClamp(p.turns, 5, 0.25, 40), radius = meshClamp(p.radius, 0.6, 0.01, 500), pitch = meshClamp(p.pitch, 0.25, 0.005, 100), tube = meshClamp(p.tubeRadius ?? p.tube, radius * 0.08, 0.001, radius * 0.45);
  const perTurn = Math.round(meshClamp(p.segmentsPerTurn, 24, 8, 120));
  const count = Math.min(MAX_PATH_POINTS - 1, Math.max(8, Math.round(turns * perTurn)));
  const path = [];
  for (let i = 0; i <= count; i++) { const t = i / count, a = t * turns * Math.PI * 2; path.push([radius * Math.cos(a), (t - 0.5) * turns * pitch, radius * Math.sin(a)]); }
  return { ...buildSweepMesh({ path, radius: tube, radialSegments: p.radialSegments ?? 10 }), recipe: "spring", topology: "open-helical-tube" };
}
function buildCapsuleMesh(p = {}) {
  const r = meshClamp(p.radius, 0.5, MIN_DIMENSION, MAX_DIMENSION), length = meshClamp(p.length, 1, 0, MAX_DIMENSION), cap = Math.round(meshClamp(p.capSegments, 8, 2, 32));
  const profile = [];
  for (let i = 0; i <= cap; i++) { const a = -Math.PI / 2 + i / cap * Math.PI / 2; profile.push([Math.max(0, r * Math.cos(a)), -length/2 + r + r * Math.sin(a)]); }
  profile.push([r, length/2]);
  for (let i = 1; i <= cap; i++) { const a = i / cap * Math.PI / 2; profile.push([r * Math.cos(a), length/2 + r * Math.sin(a)]); }
  // A lathe surface includes pole-radius degeneracy only at end profile points, as expected.
  return { ...buildLatheMesh({ profile, segments: meshClamp(p.radialSegments, 32, 8, 128) }), recipe: "capsule", topology: "closed-surface" };
}
function buildLoftBishopMesh(p = {}) {
  const spine = isObject(p.spine) ? p.spine : {};
  const rawPath = Array.isArray(spine.controlPoints) ? spine.controlPoints : (Array.isArray(p.path) ? p.path : []);
  if (rawPath.length < 2 || rawPath.length > MAX_PATH_POINTS) throw new Error("loft_bishop requires 2 to 4000 spine control points.");
  const controlPoints = rawPath.map((q, i) => {
    if (!Array.isArray(q) || q.length < 3 || !q.slice(0, 3).every(finite)) throw new Error(`Spine control point ${i} must be [x,y,z].`);
    return q.slice(0, 3).map(v => clamp(v, -MAX_DIMENSION, MAX_DIMENSION));
  });
  const stations = (Array.isArray(p.stations) ? p.stations : [{ u: 0, profile: "circle", radius: p.radius || 0.25 }, { u: 1, profile: "circle", radius: p.radius || 0.25 }])
    .slice(0, 64).map((st, i) => {
      const o = isObject(st) ? st : {};
      const type = ["circle", "ellipse", "rounded_rect"].includes(o.profile) ? o.profile : "circle";
      const radius = meshClamp(o.radius, 0.25, 1e-5, MAX_DIMENSION);
      const width = meshClamp(o.width, radius * 2, 1e-5, MAX_DIMENSION);
      const height = meshClamp(o.height, radius * 2, 1e-5, MAX_DIMENSION);
      return {
        u: clamp(finite(o.u) ? o.u : i / Math.max(1, p.stations.length - 1), 0, 1), type,
        rx: meshClamp(o.radiusX, type === "ellipse" ? radius : width / 2, 1e-5, MAX_DIMENSION),
        ry: meshClamp(o.radiusY, type === "ellipse" ? radius : height / 2, 1e-5, MAX_DIMENSION),
        width, height,
        corner: meshClamp(o.cornerRadius, Math.min(width, height) * 0.18, 0, Math.min(width, height) * 0.5),
        wall: meshClamp(o.wallThickness, 0, 0, Math.min(width, height) * 0.45)
      };
    }).sort((a, b) => a.u - b.u);
  if (stations.length < 2) throw new Error("loft_bishop requires at least two cross-section stations.");
  const segments = Math.min(512, Math.max(8, Math.round(spine.segments ?? p.tubularSegments ?? Math.max(32, controlPoints.length * 12))));
  const closed = Boolean(spine.closed ?? p.closed);
  const points = controlPoints.length > 2 && spine.curveType !== "polyline"
    ? evalCentripetalCatmullRom(controlPoints, segments, closed)
    : controlPoints;
  const radial = Math.min(96, Math.max(12, Math.round(p.radialSegments ?? 48)));
  const frames = computeBishopFramesDoubleReflection(points, closed, Number(p.twist ?? 0));
  const total = frames.totalLength || 1;
  const pickStation = (u) => {
    if (u <= stations[0].u) return [stations[0], stations[0], 0];
    if (u >= stations[stations.length - 1].u) return [stations[stations.length - 1], stations[stations.length - 1], 0];
    for (let i = 0; i < stations.length - 1; i++) if (u >= stations[i].u && u <= stations[i + 1].u) {
      const a = stations[i], b = stations[i + 1], den = Math.max(1e-9, b.u - a.u);
      return [a, b, clamp((u - a.u) / den, 0, 1)];
    }
    return [stations[0], stations[0], 0];
  };
  const mix = (a, b, t) => a + (b - a) * t;
  const dimsAt = u => {
    const [a, b, t] = pickStation(u);
    const rx = mix(a.rx, b.rx, t), ry = mix(a.ry, b.ry, t);
    const width = mix(a.width, b.width, t), height = mix(a.height, b.height, t);
    const corner = mix(a.corner, b.corner, t), wall = mix(a.wall, b.wall, t);
    // Rounded rectangles use a smooth superellipse envelope; ellipse/circle are exact.
    const type = t < 0.5 ? a.type : b.type;
    const exponent = type === "rounded_rect" ? 2 + 3 * (1 - clamp(corner / Math.max(1e-8, Math.min(width, height) * 0.5), 0, 1)) : 2;
    return { rx: type === "rounded_rect" ? width * 0.5 : rx, ry: type === "rounded_rect" ? height * 0.5 : ry, wall, exponent };
  };
  const outerRings = [], innerRings = [], vertices = [], normals = [], uvs = [], indices = [];
  const pushRing = (out, i, inner = false) => {
    const P = points[i], R = frames.normals[i], S = frames.binormals[i];
    const u = frames.arcLengths[i] / total, d = dimsAt(u);
    const wall = inner ? d.wall : 0;
    const rx = Math.max(1e-5, d.rx - wall), ry = Math.max(1e-5, d.ry - wall);
    const start = vertices.length / 3;
    for (let j = 0; j <= radial; j++) {
      const theta = j / radial * Math.PI * 2;
      const c = Math.cos(theta), sn = Math.sin(theta), exp = d.exponent;
      const fx = Math.sign(c) * Math.pow(Math.abs(c), 2 / exp), fy = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / exp);
      const x = rx * fx, y = ry * fy;
      vertices.push(P[0] + R[0] * x + S[0] * y, P[1] + R[1] * x + S[1] * y, P[2] + R[2] * x + S[2] * y);
      let gx = fx / Math.max(1e-8, rx), gy = fy / Math.max(1e-8, ry);
      let nnx = R[0] * gx + S[0] * gy, nny = R[1] * gx + S[1] * gy, nnz = R[2] * gx + S[2] * gy;
      const nl = Math.hypot(nnx, nny, nnz) || 1, normalSign = inner ? -1 : 1;
      normals.push(normalSign * nnx / nl, normalSign * nny / nl, normalSign * nnz / nl);
      uvs.push(j / radial, u);
    }
    out.push(start);
  };
  for (let i = 0; i < points.length; i++) pushRing(outerRings, i, false);
  const hollow = stations.some(st => st.wall > 1e-6);
  if (hollow) for (let i = 0; i < points.length; i++) pushRing(innerRings, i, true);
  const stride = radial + 1;
  const connect = (rings, reverse) => {
    for (let i = 0; i < points.length - 1; i++) for (let j = 0; j < radial; j++) {
      const a = rings[i] + j, b = rings[i + 1] + j;
      if (!reverse) indices.push(a, b + 1, b, a, a + 1, b + 1);
      else indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
  };
  connect(outerRings, false);
  if (hollow) {
    connect(innerRings, true);
    // Annular end lips use separate, flat-normal copies while remaining coincident
    // with the side rings; the topology audit welds these crease-normal splits.
    for (const end of [0, points.length - 1]) {
      const T = frames.tangents[end], capNormal = end === 0 ? [-T[0], -T[1], -T[2]] : [T[0], T[1], T[2]];
      const copyFlatRing = src => {
        const dst = vertices.length / 3;
        for (let j = 0; j <= radial; j++) {
          const vi = (src + j) * 3, ui = (src + j) * 2;
          vertices.push(vertices[vi], vertices[vi + 1], vertices[vi + 2]);
          normals.push(...capNormal); uvs.push(uvs[ui], uvs[ui + 1]);
        }
        return dst;
      };
      const or = copyFlatRing(outerRings[end]), ir = copyFlatRing(innerRings[end]);
      for (let j = 0; j < radial; j++) {
        const o0 = or + j, o1 = o0 + 1, i0 = ir + j, i1 = i0 + 1;
        if (end === 0) indices.push(o0, i1, i0, o0, o1, i1);
        else indices.push(o0, i0, i1, o0, i1, o1);
      }
    }
  } else if (!closed) {
    // Flat end caps have duplicated rim vertices so cap normals do not average
    // with smooth wall normals (the classic extrusion/cylinder pillow-shading fix).
    for (const end of [0, points.length - 1]) {
      const P = points[end], T = frames.tangents[end];
      const capNormal = end === 0 ? [-T[0], -T[1], -T[2]] : [T[0], T[1], T[2]];
      const center = vertices.length / 3;
      vertices.push(P[0], P[1], P[2]); normals.push(...capNormal); uvs.push(0.5, 0.5);
      const src = outerRings[end], ring = vertices.length / 3;
      for (let j = 0; j <= radial; j++) {
        const vi = (src + j) * 3, ui = (src + j) * 2;
        vertices.push(vertices[vi], vertices[vi + 1], vertices[vi + 2]);
        normals.push(...capNormal); uvs.push(uvs[ui], uvs[ui + 1]);
      }
      for (let j = 0; j < radial; j++) {
        if (end === 0) indices.push(center, ring + j + 1, ring + j);
        else indices.push(center, ring + j, ring + j + 1);
      }
    }
  }
  if (vertices.length / 3 > MAX_MESH_VERTICES || indices.length > MAX_MESH_INDICES) throw new Error("loft_bishop exceeded the configured mesh resource limits.");
  return { vertices, indices, normals, uvs, recipe: "loft_bishop", topology: hollow ? "closed-shell-boundary" : (closed ? "closed-sweep" : "closed-solid") };
}

function buildMeshRecipe(recipe, p) {
  switch (recipe) {
    case "beveled_box": return buildBeveledBoxMesh(p);
    case "extrude": return buildExtrudeMesh(p);
    case "lathe": return buildLatheMesh(p);
    case "sweep": return buildSweepMesh(p);
    case "loft_bishop": return buildLoftBishopMesh(p);
    case "sdf": case "sdf_dual_contouring": return polygonizeSDFDualContouring(p);
    case "gear": return buildGearMesh(p);
    case "spring": return buildSpringMesh(p);
    case "capsule": return buildCapsuleMesh(p);
    default: throw new Error(`Unsupported mesh recipe '${recipe}'.`);
  }
}
/**
 * Geometric topology audit that welds coincident seam vertices for analysis while
 * leaving render vertices untouched (so UV seams and split crease normals survive).
 * Edge incidence 2 everywhere is necessary for a closed 2-manifold triangle surface.
 */
export function analyzeMeshTopology3D(vertices, indices, epsilon) {
  if (!Array.isArray(vertices) || vertices.length % 3 || !Array.isArray(indices) || indices.length % 3) {
    return { valid: false, watertight: false, manifold: false, vertices: 0, edges: 0, faces: 0, boundaryEdges: null, nonManifoldEdges: null };
  }
  const count = vertices.length / 3;
  if (count === 0 || count > MAX_MESH_VERTICES || indices.length > MAX_MESH_INDICES || indices.some(i => !Number.isInteger(i) || i < 0 || i >= count)) {
    return { valid: false, watertight: false, manifold: false, vertices: count, edges: 0, faces: indices.length / 3, boundaryEdges: null, nonManifoldEdges: null };
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
    if (![x, y, z].every(Number.isFinite)) return { valid: false, watertight: false, manifold: false, vertices: count, edges: 0, faces: indices.length / 3, boundaryEdges: null, nonManifoldEdges: null };
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const eps = finite(epsilon) && epsilon > 0 ? epsilon : Math.max(1e-8, diagonal * 1e-7);
  const welded = new Int32Array(count), pointIds = new Map();
  for (let i = 0; i < count; i++) {
    const x = Math.round(vertices[i * 3] / eps), y = Math.round(vertices[i * 3 + 1] / eps), z = Math.round(vertices[i * 3 + 2] / eps);
    const key = `${x},${y},${z}`;
    let id = pointIds.get(key);
    if (id === undefined) { id = pointIds.size; pointIds.set(key, id); }
    welded[i] = id;
  }
  const edgeCounts = new Map();
  let degenerateFaces = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = welded[indices[i]], b = welded[indices[i + 1]], c = welded[indices[i + 2]];
    if (a === b || b === c || c === a) { degenerateFaces++; continue; }
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
    }
  }
  let boundaryEdges = 0, nonManifoldEdges = 0;
  for (const val of edgeCounts.values()) { if (val === 1) boundaryEdges++; else if (val !== 2) nonManifoldEdges++; }
  const edgeCount = edgeCounts.size, faceCount = indices.length / 3 - degenerateFaces;
  return {
    valid: true,
    watertight: boundaryEdges === 0 && nonManifoldEdges === 0 && degenerateFaces === 0,
    manifold: nonManifoldEdges === 0,
    vertices: pointIds.size,
    renderVertices: count,
    edges: edgeCount,
    faces: faceCount,
    boundaryEdges,
    nonManifoldEdges,
    degenerateFaces,
    eulerCharacteristic: pointIds.size - edgeCount + faceCount,
    epsilon: eps
  };
}

function normalizeMeshGeometry(raw, warnings, path) {
  const g = isObject(raw) ? raw : {};
  const recipe = cleanString(g.recipe, "custom", 40).toLowerCase();
  if (!MESH_RECIPES.has(recipe)) {
    warnings.push({ code: "UNKNOWN_MESH_RECIPE", path: `${path}.geometry.recipe`, message: `Unsupported mesh recipe '${recipe}'.` });
    return { recipe, vertices: [], indices: [], topology: "invalid", geometryError: "UNKNOWN_MESH_RECIPE" };
  }
  let built;
  try {
    if (recipe === "custom") built = { vertices: g.vertices, indices: g.indices, normals: g.normals, uvs: g.uvs, recipe, topology: "custom" };
    else built = buildMeshRecipe(recipe, isObject(g.parameters) ? g.parameters : g);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown mesh build error.";
    warnings.push({ code: "MESH_RECIPE_FAILED", path: `${path}.geometry`, message: `${message.slice(0, 220)} Mesh was not fabricated.` });
    return { recipe, vertices: [], indices: [], topology: "invalid", geometryError: message.slice(0, 220) };
  }
  const vertices = flatNumberArray(built.vertices, MAX_MESH_VERTICES * 3, true);
  const indices = Array.isArray(built.indices) && built.indices.length <= MAX_MESH_INDICES && built.indices.every(v => Number.isInteger(v) && v >= 0) ? built.indices.slice() : null;
  const normals = built.normals === undefined ? undefined : flatNumberArray(built.normals, MAX_MESH_VERTICES * 3, true);
  const uvs = built.uvs === undefined ? undefined : flatNumberArray(built.uvs, MAX_MESH_VERTICES * 2, false);
  let error = null;
  if (!vertices || vertices.length < 9 || vertices.length % 3 !== 0) error = "Mesh vertices must be finite XYZ triples within the configured vertex limit.";
  else if (!indices || indices.length < 3 || indices.length % 3 !== 0) error = "Mesh indices must be triangle triples within the configured index limit.";
  else if (indices.some(i => i >= vertices.length / 3)) error = "Mesh index references a vertex outside the vertex array.";
  else if (normals && (normals.length !== vertices.length || !normals.every(finite))) error = "Mesh normals must match the vertex count.";
  else if (uvs && (uvs.length !== vertices.length / 3 * 2 || !uvs.every(finite))) error = "Mesh UVs must contain one finite UV pair per vertex.";
  if (!error && vertices && indices) {
    // Drop triangles with repeated indices or near-zero area; never fabricate missing faces.
    const clean = [];
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      if (a === b || b === c || c === a) continue;
      const ax = vertices[a * 3], ay = vertices[a * 3 + 1], az = vertices[a * 3 + 2];
      const abx = vertices[b * 3] - ax, aby = vertices[b * 3 + 1] - ay, abz = vertices[b * 3 + 2] - az;
      const acx = vertices[c * 3] - ax, acy = vertices[c * 3 + 1] - ay, acz = vertices[c * 3 + 2] - az;
      const area2 = Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx);
      if (area2 > 1e-12) clean.push(a, b, c);
    }
    if (clean.length !== indices.length) warnings.push({ code: "DEGENERATE_TRIANGLES_REMOVED", path: `${path}.geometry`, message: `Removed ${(indices.length - clean.length) / 3} degenerate triangles during mesh validation.` });
    indices.length = 0;
    for (const index of clean) indices.push(index);
    if (indices.length < 3) error = "Mesh has no non-degenerate triangles after validation.";
  }
  if (error) {
    warnings.push({ code: "INVALID_MESH_DATA", path: `${path}.geometry`, message: error });
    return { recipe, vertices: [], indices: [], topology: "invalid", geometryError: error };
  }
  if (vertices.length / 3 > MAX_MESH_VERTICES || indices.length > MAX_MESH_INDICES) {
    warnings.push({ code: "MESH_RESOURCE_LIMIT", path: `${path}.geometry`, message: "Mesh exceeded configured vertex/index bounds and was rejected." });
    return { recipe, vertices: [], indices: [], topology: "invalid", geometryError: "MESH_RESOURCE_LIMIT" };
  }
  const topologyReport = analyzeMeshTopology3D(vertices, indices);
  const topology = cleanString(built.topology, "unspecified", 40);
  if (topology.includes("closed") && !topologyReport.watertight) {
    warnings.push({ code: "MESH_TOPOLOGY_AUDIT_FAILED", path: `${path}.geometry`, message: `Closed-surface audit found ${topologyReport.boundaryEdges} boundary edges and ${topologyReport.nonManifoldEdges} non-manifold edges.` });
  }
  return { recipe, vertices, indices, ...(normals ? { normals } : {}), ...(uvs ? { uvs } : {}), topology, topologyReport, vertexCount: vertices.length / 3, triangleCount: indices.length / 3 };
}

function normalizeGeometry(raw, primitive, warnings, path) {
  const allowed = {
    box: ["width", "height", "depth", "segments", "bevel", "bevelSize", "bevelSegments"],
    sphere: ["radius", "widthSegments", "heightSegments", "phiStart", "phiLength", "thetaStart", "thetaLength"],
    cylinder: ["radiusTop", "radiusBottom", "height", "radialSegments", "openEnded", "thetaStart", "thetaLength"],
    cone: ["radius", "height", "radialSegments", "openEnded", "thetaStart", "thetaLength"],
    torus: ["radius", "tube", "radialSegments", "tubularSegments", "arc"],
    plane: ["width", "height", "widthSegments", "heightSegments"],
    capsule: ["radius", "length", "capSegments", "radialSegments"],
    mesh: ["recipe", "parameters", "vertices", "indices", "normals", "uvs", "profile", "points", "path", "width", "height", "depth", "bevel", "bevelSize", "segments", "bevelSegments", "radius", "outerRadius", "rootRadius", "boreRadius", "thickness", "teeth", "turns", "pitch", "tubeRadius", "radialSegments", "segmentsPerTurn", "capSegments", "spine", "stations", "resolution", "bounds", "root", "creaseAngleDeg", "closed", "twist", "interpolate"]
  }[primitive] || [];
  const g = safeObject(raw, allowed, warnings, `${path}.geometry`);
  const dim = (v, fallback, p) => num(v, fallback, MIN_DIMENSION, MAX_DIMENSION, warnings, p);
  const seg = (v, fallback, min, max, p) => Math.round(num(v, fallback, min, max, warnings, p));
  switch (primitive) {
    case "box": {
      const width = dim(g.width, 1, `${path}.geometry.width`), height = dim(g.height, 1, `${path}.geometry.height`), depth = dim(g.depth, 1, `${path}.geometry.depth`);
      const bevel = num(g.bevelSize ?? g.bevel, 0, 0, Math.min(width, height, depth) * 0.499, warnings, `${path}.geometry.bevelSize`);
      const result = {
        width, height, depth,
        widthSegments: seg(g.segments?.[0], 1, 1, 256, `${path}.geometry.segments[0]`),
        heightSegments: seg(g.segments?.[1], 1, 1, 256, `${path}.geometry.segments[1]`),
        depthSegments: seg(g.segments?.[2], 1, 1, 256, `${path}.geometry.segments[2]`)
      };
      // Preserve the v2.5 payload exactly for ordinary boxes; new fields appear only when used.
      if (bevel > 0) {
        result.bevelSize = bevel;
        result.bevelSegments = seg(g.bevelSegments, 3, 1, 12, warnings, `${path}.geometry.bevelSegments`);
      }
      return result;
    }
    case "sphere": return {
      radius: dim(g.radius, 1, `${path}.geometry.radius`),
      widthSegments: seg(g.widthSegments, 48, 3, 256, `${path}.geometry.widthSegments`),
      heightSegments: seg(g.heightSegments, 24, 2, 256, `${path}.geometry.heightSegments`),
      phiStart: num(g.phiStart, 0, 0, Math.PI * 2, warnings, `${path}.geometry.phiStart`),
      phiLength: num(g.phiLength, Math.PI * 2, 0.001, Math.PI * 2, warnings, `${path}.geometry.phiLength`),
      thetaStart: num(g.thetaStart, 0, 0, Math.PI, warnings, `${path}.geometry.thetaStart`),
      thetaLength: num(g.thetaLength, Math.PI, 0.001, Math.PI, warnings, `${path}.geometry.thetaLength`)
    };
    case "cylinder": return {
      radiusTop: dim(g.radiusTop, 1, `${path}.geometry.radiusTop`),
      radiusBottom: dim(g.radiusBottom, 1, `${path}.geometry.radiusBottom`),
      height: dim(g.height, 1, `${path}.geometry.height`),
      radialSegments: seg(g.radialSegments, 48, 3, 256, `${path}.geometry.radialSegments`),
      openEnded: Boolean(g.openEnded),
      thetaStart: num(g.thetaStart, 0, 0, Math.PI * 2, warnings, `${path}.geometry.thetaStart`),
      thetaLength: num(g.thetaLength, Math.PI * 2, 0.001, Math.PI * 2, warnings, `${path}.geometry.thetaLength`)
    };
    case "cone": return {
      radius: dim(g.radius, 1, `${path}.geometry.radius`),
      height: dim(g.height, 1, `${path}.geometry.height`),
      radialSegments: seg(g.radialSegments, 48, 3, 256, `${path}.geometry.radialSegments`),
      openEnded: Boolean(g.openEnded),
      thetaStart: num(g.thetaStart, 0, 0, Math.PI * 2, warnings, `${path}.geometry.thetaStart`),
      thetaLength: num(g.thetaLength, Math.PI * 2, 0.001, Math.PI * 2, warnings, `${path}.geometry.thetaLength`)
    };
    case "torus": return {
      radius: dim(g.radius, 1, `${path}.geometry.radius`),
      tube: dim(g.tube, 0.2, `${path}.geometry.tube`),
      radialSegments: seg(g.radialSegments, 24, 3, 128, `${path}.geometry.radialSegments`),
      tubularSegments: seg(g.tubularSegments, 96, 3, 384, `${path}.geometry.tubularSegments`),
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
      capSegments: seg(g.capSegments, 6, 1, 32, `${path}.geometry.capSegments`),
      radialSegments: seg(g.radialSegments, 24, 3, 128, `${path}.geometry.radialSegments`)
    };
    case "mesh": return normalizeMeshGeometry(g, warnings, path);
    default: return {};
  }
}

function normalizeObject(raw, index, ids, materialIds, warnings) {
  const path = `objects[${index}]`;
  const allowed = ["id", "name", "type", "primitive", "geometry", "position", "rotation", "scale", "material", "visible", "castShadow", "receiveShadow", "userData", "renderOrder"];
  const obj = safeObject(raw, allowed, warnings, path);
  let primitive = cleanString(obj.primitive ?? obj.type, "box", 40).toLowerCase();
  const originalPrimitive = primitive;
  primitive = PRIMITIVE_ALIASES[primitive] || primitive;
  const originalGeometry = isObject(obj.geometry) ? { ...obj.geometry } : {};
  if (originalPrimitive === "sdf") {
    primitive = "mesh";
    obj.geometry = { recipe: "sdf", parameters: originalGeometry };
  } else if (originalPrimitive === "loft_bishop") {
    primitive = "mesh";
    obj.geometry = { recipe: "loft_bishop", parameters: originalGeometry };
  } else if (MESH_PRIMITIVE_RECIPES[originalPrimitive]) {
    primitive = "mesh";
    obj.geometry = { recipe: MESH_PRIMITIVE_RECIPES[originalPrimitive], parameters: originalGeometry };
  } else if (originalPrimitive === "pyramid") {
    obj.geometry = { ...originalGeometry, radialSegments: 4 };
    obj.rotation = vector3(obj.rotation, [0, Math.PI / 4, 0], Math.PI * 1_000, warnings, `${path}.rotation`);
  } else if (["triangular_prism", "hex_prism", "hexagonal_prism", "octagonal_prism", "disk", "disc", "rod"].includes(originalPrimitive)) {
    const defaultSegments = originalPrimitive === "triangular_prism" ? 3 : (originalPrimitive === "hex_prism" || originalPrimitive === "hexagonal_prism" ? 6 : (originalPrimitive === "octagonal_prism" ? 8 : 32));
    const radius = finite(originalGeometry.radius) ? originalGeometry.radius : 1;
    obj.geometry = {
      radiusTop: finite(originalGeometry.radiusTop) ? originalGeometry.radiusTop : radius,
      radiusBottom: finite(originalGeometry.radiusBottom) ? originalGeometry.radiusBottom : radius,
      height: finite(originalGeometry.height) ? originalGeometry.height : (finite(originalGeometry.length) ? originalGeometry.length : (finite(originalGeometry.thickness) ? originalGeometry.thickness : 1)),
      radialSegments: finite(originalGeometry.radialSegments) ? originalGeometry.radialSegments : defaultSegments,
      openEnded: Boolean(originalGeometry.openEnded)
    };
  } else if (originalPrimitive === "ring" || originalPrimitive === "donut" || originalPrimitive === "washer") {
    obj.geometry = { radius: finite(originalGeometry.radius) ? originalGeometry.radius : (finite(originalGeometry.majorRadius) ? originalGeometry.majorRadius : 1), tube: finite(originalGeometry.tube) ? originalGeometry.tube : (finite(originalGeometry.minorRadius) ? originalGeometry.minorRadius : 0.2), radialSegments: originalGeometry.radialSegments, tubularSegments: originalGeometry.tubularSegments, arc: originalGeometry.arc };
  } else if (originalPrimitive === "ellipsoid") {
    const rx = val(originalGeometry, "radiusX", finite(originalGeometry.width) ? originalGeometry.width / 2 : 1, MIN_DIMENSION, MAX_DIMENSION);
    const ry = val(originalGeometry, "radiusY", finite(originalGeometry.height) ? originalGeometry.height / 2 : 1, MIN_DIMENSION, MAX_DIMENSION);
    const rz = val(originalGeometry, "radiusZ", finite(originalGeometry.depth) ? originalGeometry.depth / 2 : 1, MIN_DIMENSION, MAX_DIMENSION);
    obj.geometry = { radius: 1, widthSegments: originalGeometry.widthSegments || 48, heightSegments: originalGeometry.heightSegments || 24 };
    const baseScale = v3(obj.scale, [1, 1, 1]);
    obj.scale = [baseScale[0] * rx, baseScale[1] * ry, baseScale[2] * rz];
  }
  if (!BASE_PRIMITIVES.has(primitive) && primitive !== "mesh") {
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
    renderOrder: Math.round(num(obj.renderOrder, 0, -100_000, 100_000, warnings, `${path}.renderOrder`)),
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
  const obj = safeObject(raw, ["position", "target", "fov", "near", "far", "zoom", "dof"], warnings, path);
  const near = num(obj.near, 0.1, 0.001, 10_000, warnings, `${path}.near`);
  const far = num(obj.far, 10_000, near + 0.01, 100_000_000, warnings, `${path}.far`);
  return {
    position: vector3(obj.position, [6, 5, 8], MAX_ABS_COORD, warnings, `${path}.position`),
    target: vector3(obj.target, [0, 0, 0], MAX_ABS_COORD, warnings, `${path}.target`),
    fov: num(obj.fov, 45, 1, 120, warnings, `${path}.fov`),
    near,
    far: Math.max(far, near + 0.01),
    zoom: num(obj.zoom, 1, 0.01, 100, warnings, `${path}.zoom`),
    dof: isObject(obj.dof) ? { enabled: Boolean(obj.dof.enabled), focusDistance: num(obj.dof.focusDistance, 4, 0.01, 1_000_000, warnings, `${path}.dof.focusDistance`), focalLengthMm: num(obj.dof.focalLengthMm, 50, 8, 300, warnings, `${path}.dof.focalLengthMm`), fStop: num(obj.dof.fStop, 4, 0.7, 32, warnings, `${path}.dof.fStop`) } : { enabled: false, focusDistance: 4, focalLengthMm: 50, fStop: 4 }
  };
}

function normalizeEnvironment(raw, warnings) {
  const obj = safeObject(raw, ["background", "ground", "grid", "axes", "toneMapping", "exposure", "studioPreset", "studioSoftboxes"], warnings, "environment");
  const ground = isObject(obj.ground) ? {
    enabled: obj.ground.enabled !== false,
    color: color(obj.ground.color, "#e9edf2", warnings, "environment.ground.color"),
    size: num(obj.ground.size, 100, 1, MAX_DIMENSION, warnings, "environment.ground.size"),
    y: num(obj.ground.y, -0.01, -MAX_ABS_COORD, MAX_ABS_COORD, warnings, "environment.ground.y"),
    contactShadows: isObject(obj.ground.contactShadows) ? { enabled: obj.ground.contactShadows.enabled !== false, opacity: num(obj.ground.contactShadows.opacity, 0.55, 0, 1, warnings, "environment.ground.contactShadows.opacity"), blur: num(obj.ground.contactShadows.blur, 2, 0, 10, warnings, "environment.ground.contactShadows.blur"), maxDistance: num(obj.ground.contactShadows.maxDistance, 1.5, 0.01, 100, warnings, "environment.ground.contactShadows.maxDistance") } : { enabled: false, opacity: 0.55, blur: 2, maxDistance: 1.5 }
  } : { enabled: true, color: "#e9edf2", size: 100, y: -0.01, contactShadows: { enabled: false, opacity: 0.55, blur: 2, maxDistance: 1.5 } };
  const softboxes = Array.isArray(obj.studioSoftboxes) ? obj.studioSoftboxes.slice(0, 12).map((rawBox, i) => {
    const b = isObject(rawBox) ? rawBox : {};
    return { position: vector3(b.position, [0, 5, 0], MAX_ABS_COORD, warnings, `environment.studioSoftboxes[${i}].position`), size: vector3(b.size, [4, 4, 1], MAX_DIMENSION, warnings, `environment.studioSoftboxes[${i}].size`), color: color(b.color, "#ffffff", warnings, `environment.studioSoftboxes[${i}].color`), intensity: num(b.intensity, 4, 0, 100, warnings, `environment.studioSoftboxes[${i}].intensity`) };
  }) : [];
  return {
    background: color(obj.background, "#f4f6f9", warnings, "environment.background"),
    ground,
    grid: obj.grid !== false,
    axes: Boolean(obj.axes),
    toneMapping: ["none", "linear", "reinhard", "aces", "agx"].includes(obj.toneMapping) ? (obj.toneMapping || "agx") : "agx",
    exposure: num(obj.exposure, 1, 0.01, 10, warnings, "environment.exposure"),
    studioPreset: cleanString(obj.studioPreset, "studio_softbox", 40),
    studioSoftboxes: softboxes
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


/* --------------------------------------------------------------------------
 * Compound model compiler
 *
 * High-level assemblies are converted to the seven primitives supported by
 * ArixAI's current Three.js renderer. No generated JS is executed. All parts
 * remain ordinary validated scene objects, so downstream rendering stays safe.
 * -------------------------------------------------------------------------- */
/**
 * Dynamic-model policy (v4): this compiler intentionally does not expand named
 * assembly/model blueprints into a hardcoded collection of overlapping parts.
 * Caller-authored geometry must arrive as explicit primitives, mesh buffers, or
 * procedural recipes (SDF / Bishop loft / sweep / lathe / gear, etc.).
 */
function expandAssemblies(rawObjects, globalWarnings) {
  const output = [];
  for (let i = 0; i < rawObjects.length && output.length < MAX_EXPANDED_OBJECTS; i++) {
    const raw = rawObjects[i];
    if (!isObject(raw)) {
      globalWarnings.push({ code: "INVALID_OBJECT", path: `objects[${i}]`, message: "Non-object scene entry was ignored." });
      continue;
    }
    if (raw.assembly !== undefined || raw.model !== undefined || raw.blueprint !== undefined) {
      globalWarnings.push({
        code: "PREDEFINED_MODEL_DISABLED",
        severity: "info",
        path: `objects[${i}]`,
        message: "Named assembly/model blueprints are disabled. Supply live declarative geometry using primitive types, mesh vertices/indices, or a procedural recipe."
      });
      continue;
    }
    output.push(raw);
  }
  if (rawObjects.length && output.length >= MAX_EXPANDED_OBJECTS) {
    globalWarnings.push({ code: "EXPANDED_OBJECT_LIMIT", path: "objects", message: `Scene truncated at ${MAX_EXPANDED_OBJECTS} objects to protect memory and render performance.` });
  }
  return output;
}

function normalizeModeling(rawModeling, rawQuality, rawPrecision, warnings) {
  const raw = isObject(rawModeling) ? rawModeling : {};
  const quality = cleanString(raw.quality ?? rawQuality, "high", 20).toLowerCase();
  const allowedQuality = new Set(["draft", "balanced", "high", "ultra"]);
  if (!allowedQuality.has(quality)) warnings.push({ code: "INVALID_QUALITY_PROFILE", path: "modeling.quality", message: `Unknown quality profile '${quality}'; 'high' is used.` });
  const precision = cleanString(raw.precision ?? rawPrecision, "dimensioned-when-specified", 48).toLowerCase();
  const validPrecision = new Set(["visual", "dimensioned-when-specified", "engineering-checked"]);
  if (!validPrecision.has(precision)) warnings.push({ code: "INVALID_PRECISION_PROFILE", path: "modeling.precision", message: `Unknown precision profile '${precision}'; 'dimensioned-when-specified' is used.` });
  return {
    quality: allowedQuality.has(quality) ? quality : "high",
    precision: validPrecision.has(precision) ? precision : "dimensioned-when-specified",
    deterministicSeed: Math.round(num(raw.seed, 137, 0, 2_147_483_647, warnings, "modeling.seed")),
    targetPolygonBudget: Math.round(num(raw.targetPolygonBudget, quality === "ultra" ? 250_000 : quality === "high" ? 120_000 : quality === "balanced" ? 45_000 : 12_000, 500, 1_000_000, warnings, "modeling.targetPolygonBudget")),
    source: cleanString(raw.source, "single-ai-scene-spec", 80),
    preserveExplicitDimensions: raw.preserveExplicitDimensions !== false,
    noExternalInference: true
  };
}
function applySceneConstraints(rawConstraints, objects, warnings) {
  if (rawConstraints === undefined) return [];
  if (!Array.isArray(rawConstraints)) {
    warnings.push({ code: "INVALID_CONSTRAINTS", path: "constraints", message: "Constraints must be an array; no constraints were applied." });
    return [];
  }
  const byId = new Map(objects.map(o => [o.id, o]));
  const result = [];
  const allowedTypes = new Set(["align", "offset", "distance", "mirror_position", "coincident", "copy_rotation", "copy_scale"]);
  for (let i = 0; i < rawConstraints.length && i < 1000; i++) {
    const c = rawConstraints[i];
    const path = `constraints[${i}]`;
    const item = safeObject(c, ["type", "objectId", "targetId", "axis", "value", "offset", "distance", "tolerance"], warnings, path);
    const type = cleanString(item.type, "", 40).toLowerCase();
    const objectId = cleanString(item.objectId, "", 80), targetId = cleanString(item.targetId, "", 80);
    const obj = byId.get(objectId), target = byId.get(targetId);
    if (!allowedTypes.has(type)) {
      warnings.push({ code: "UNSUPPORTED_CONSTRAINT", path, message: `Constraint type '${type}' is not supported and was not applied.` });
      result.push({ type, objectId, targetId, applied: false, reason: "unsupported" }); continue;
    }
    if (!obj) {
      warnings.push({ code: "CONSTRAINT_OBJECT_MISSING", path, message: "Constraint object was not found; constraint was not applied." });
      result.push({ type, objectId, targetId, applied: false, reason: "missing_object" }); continue;
    }
    if ((type !== "align" || item.value === undefined) && !target) {
      warnings.push({ code: "CONSTRAINT_TARGET_MISSING", path, message: "Constraint target object was not found; constraint was not applied." });
      result.push({ type, objectId, targetId, applied: false, reason: "missing_target" }); continue;
    }
    const axis = ["x", "y", "z"].indexOf(item.axis);
    if (type === "align") {
      if (axis < 0) { warnings.push({ code: "CONSTRAINT_AXIS_INVALID", path, message: "Align constraint requires axis x, y, or z." }); result.push({ type, objectId, targetId, applied: false, reason: "invalid_axis" }); continue; }
      const value = finite(item.value) ? clamp(item.value, -MAX_ABS_COORD, MAX_ABS_COORD) : target.position[axis];
      obj.position[axis] = value;
    } else if (type === "offset") {
      const offset = v3(item.offset, [0, 0, 0]).map(v => clamp(v, -MAX_ABS_COORD, MAX_ABS_COORD));
      obj.position = target.position.map((v, j) => v + offset[j]);
    } else if (type === "distance") {
      const distance = num(item.distance, 1, 0, MAX_ABS_COORD, warnings, `${path}.distance`);
      let direction = obj.position.map((v, j) => v - target.position[j]);
      if (axis >= 0) direction = [0, 0, 0].map((_, j) => j === axis ? (direction[j] || 1) : 0);
      let length = Math.hypot(...direction);
      if (length < 1e-10) { direction = axis >= 0 ? [0,0,0].map((_, j) => j === axis ? 1 : 0) : [1,0,0]; length = 1; }
      obj.position = target.position.map((v, j) => v + direction[j] / length * distance);
    } else if (type === "mirror_position") {
      if (axis < 0) { warnings.push({ code: "CONSTRAINT_AXIS_INVALID", path, message: "Mirror constraint requires axis x, y, or z." }); result.push({ type, objectId, targetId, applied: false, reason: "invalid_axis" }); continue; }
      obj.position[axis] = -target.position[axis];
    } else if (type === "coincident") obj.position = [...target.position];
    else if (type === "copy_rotation") obj.rotation = [...target.rotation];
    else if (type === "copy_scale") obj.scale = [...target.scale];
    result.push({ type, objectId, targetId, applied: true, ...(finite(item.tolerance) ? { tolerance: clamp(item.tolerance, 0, MAX_DIMENSION) } : {}) });
  }
  if (rawConstraints.length > 1000) warnings.push({ code: "CONSTRAINT_LIMIT", path: "constraints", message: "Only the first 1000 constraints were considered." });
  return result;
}

function normalizeScene(raw, parseRepairs = []) {
  const warnings = [];
  const top = safeObject(raw, ["$schema", "schema", "version", "title", "units", "camera", "environment", "materials", "lights", "objects", "animations", "metadata", "constraints", "modeling", "quality", "precision"], warnings, "scene");
  const rawObjects = Array.isArray(top.objects) ? top.objects : [];
  if (!Array.isArray(top.objects)) warnings.push({ code: "OBJECTS_DEFAULTED", path: "objects", message: "Missing or invalid objects array; an empty scene was created." });
  if (rawObjects.length > MAX_OBJECTS) warnings.push({ code: "OBJECT_LIMIT", path: "objects", message: `Only the first ${MAX_OBJECTS} objects are accepted.` });
  const rawMaterials = Array.isArray(top.materials) ? top.materials : [];
  if (rawMaterials.length > MAX_MATERIALS) warnings.push({ code: "MATERIAL_LIMIT", path: "materials", message: `Only the first ${MAX_MATERIALS} materials are accepted.` });
  const materialSeen = new Set();
  const materials = rawMaterials.slice(0, MAX_MATERIALS).map((m, i) => normalizeMaterial(m, i, materialSeen, warnings));
  const materialIds = new Set(materials.map(m => m.id));
  const ids = new Set();
  const expandedObjects = expandAssemblies(rawObjects.slice(0, MAX_OBJECTS), warnings);
  const objects = expandedObjects.slice(0, MAX_EXPANDED_OBJECTS).filter(isObject).map((o, i) => normalizeObject(o, i, ids, materialIds, warnings));
  const constraints = applySceneConstraints(top.constraints, objects, warnings);
  const objectIds = new Set(objects.map(o => o.id));
  const rawLights = Array.isArray(top.lights) ? top.lights : [
    { type: "ambient", intensity: 0.7 },
    { type: "directional", intensity: 1.4, position: [5, 8, 6], castShadow: true }
  ];
  if (rawLights.length > MAX_LIGHTS) warnings.push({ code: "LIGHT_LIMIT", path: "lights", message: `Only the first ${MAX_LIGHTS} lights are accepted.` });
  const lights = rawLights.slice(0, MAX_LIGHTS).map((light, i) => normalizeLight(light, i, warnings));
  const animations = normalizeAnimation(top.animations, objectIds, warnings);
  const metadata = isObject(top.metadata) ? sanitizePlainData(top.metadata, warnings, "metadata", 0) : {};
  const modeling = normalizeModeling(top.modeling, top.quality, top.precision, warnings);
  const meshObjects = objects.filter(o => o.primitive === "mesh");
  const qualityReport = {
    objectCount: objects.length,
    meshObjectCount: meshObjects.length,
    meshVertexCount: meshObjects.reduce((sum, o) => sum + (o.geometry?.vertexCount || 0), 0),
    meshTriangleCount: meshObjects.reduce((sum, o) => sum + (o.geometry?.triangleCount || 0), 0),
    generatedGeometry: "deterministic-procedural",
    dimensionalAccuracy: "Only as accurate as supplied dimensions and construction rules; no external reference measurement is performed."
  };
  return {
    schema: "arixai.scene",
    version: 4,
    compilerVersion: VERSION,
    title: cleanString(top.title, "ArixAI 3D Scene", 160),
    units: cleanString(top.units, "unitless", 40),
    camera: normalizeCamera(top.camera, warnings),
    environment: normalizeEnvironment(top.environment, warnings),
    materials,
    lights,
    objects,
    animations,
    constraints,
    modeling,
    qualityReport,
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
    const strictFailure = isObject(options) && options.strict === true && (warnings.some(w => w.severity !== "info") || parsed.repairs.length > 0);
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
    version: 2,
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


/**
 * Legacy API retained so old callers receive an explicit migration message.
 * Version 4 intentionally has no predefined compound model library.
 */
export function createAssembly(type, options = {}) {
  return {
    ok: false,
    error: `Predefined assembly '${cleanString(type, "unknown", 80)}' is disabled in v4. Build a live declarative scene from primitives, SDF, loft_bishop, sweep, lathe, gear, or custom mesh geometry.`,
    supported: ["primitive", "mesh", "sdf", "loft_bishop", "sweep", "lathe", "gear", "spring", "capsule"]
  };
}

/** Machine-readable capabilities for the dynamic, zero-API compiler. */
export function capabilities3D() {
  return {
    compilerVersion: VERSION,
    primitives: [...BASE_PRIMITIVES, "mesh", "sdf", "loft_bishop"].sort(),
    meshRecipes: [...MESH_RECIPES].sort(),
    materialPresets: Object.keys(MATERIAL_PRESETS).sort(),
    aliases: { ...PRIMITIVE_ALIASES },
    assemblies: [],
    dynamicGeometry: ["custom_mesh", "sdf_dual_contouring", "loft_bishop", "bishop_sweep", "lathe", "extrude", "gear", "spring", "capsule"],
    maxInputCharacters: MAX_INPUT_CHARS,
    maxInputObjects: MAX_OBJECTS,
    maxExpandedObjects: MAX_EXPANDED_OBJECTS,
    security: { executesGeneratedCode: false, acceptsDeclarativeSceneData: true, meshVertexLimit: MAX_MESH_VERTICES, meshIndexLimit: MAX_MESH_INDICES },
    rendererHelpers: ["buildThreeScene", "applyRendererSettings3D", "updateAnimations3D", "createProceduralTexture3D", "createProceduralStudioEnvironment3D", "buildScharrNormalTexture3D"]
  };
}


/* --------------------------------------------------------------------------
 * Optional Three.js adapter. Three.js is passed in by the host application;
 * this module remains dependency-free and safe to import in server contexts.
 * -------------------------------------------------------------------------- */
function resolvedSceneInput(input) {
  if (isObject(input) && isObject(input.scene) && input.scene.schema === "arixai.scene") return { scene: input.scene, diagnostics: input.diagnostics || input.scene.diagnostics || null };
  if (isObject(input) && input.schema === "arixai.scene") return { scene: input, diagnostics: input.diagnostics || null };
  const compiled = compile3D(input);
  if (!compiled.scene) throw new Error(compiled.error || "Could not compile scene input.");
  return { scene: compiled.scene, diagnostics: compiled.diagnostics };
}
function normalizedMaterialForThree(THREE, m, envMap, textureFactory) {
  const physical = typeof THREE.MeshPhysicalMaterial === "function" && (m.clearcoat > 0 || m.sheen > 0 || m.transmission > 0 || m.specularIntensity !== 1 || m.ior !== 1.5 || m.anisotropy > 0);
  const Ctor = physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const side = m.side === "double" ? THREE.DoubleSide : m.side === "back" ? THREE.BackSide : THREE.FrontSide;
  const params = {
    name: m.name,
    color: m.color,
    roughness: m.roughness,
    metalness: m.metalness,
    opacity: m.opacity,
    transparent: m.transparent,
    wireframe: m.wireframe,
    side,
    emissive: m.emissive,
    emissiveIntensity: m.emissiveIntensity,
    flatShading: m.flatShading,
    depthWrite: m.depthWrite,
    depthTest: m.depthTest,
    alphaTest: m.alphaTest,
    vertexColors: m.vertexColors,
    envMapIntensity: m.envMapIntensity
  };
  if (physical) Object.assign(params, {
    clearcoat: m.clearcoat, clearcoatRoughness: m.clearcoatRoughness,
    sheen: m.sheen, sheenRoughness: m.sheenRoughness, sheenColor: m.sheenColor,
    anisotropy: m.anisotropy || 0, anisotropyRotation: m.anisotropyRotation || 0,
    specularIntensity: m.specularIntensity, specularColor: m.specularColor,
    ior: m.ior, transmission: m.transmission, thickness: m.thickness,
    attenuationColor: m.attenuationColor, attenuationDistance: m.attenuationDistance
  });
  if (envMap) params.envMap = envMap;
  const material = new Ctor(params);
  if (m.proceduralTexture && typeof textureFactory === "function") {
    const maps = textureFactory(m.proceduralTexture, { size: 256, seed: m.seed, scale: m.textureScale, normalScale: m.normalScale, grainScale: m.grainScale, roughnessVariation: m.roughnessVariation });
    if (maps) {
      material.map = maps.map || null;
      material.normalMap = maps.normalMap || null;
      if (material.normalMap && material.normalScale && typeof material.normalScale.set === "function") material.normalScale.set(m.normalScale, m.normalScale);
      if (maps.roughnessMap) material.roughnessMap = maps.roughnessMap;
      material.needsUpdate = true;
    }
  }
  return material;
}
function geometryFromMeshPayload(THREE, payload) {
  if (!payload || !Array.isArray(payload.vertices) || !payload.vertices.length || !Array.isArray(payload.indices) || !payload.indices.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(payload.vertices, 3));
  if (Array.isArray(payload.normals) && payload.normals.length === payload.vertices.length && typeof THREE.Float32BufferAttribute === "function") g.setAttribute("normal", new THREE.Float32BufferAttribute(payload.normals, 3));
  if (Array.isArray(payload.uvs) && payload.uvs.length === payload.vertices.length / 3 * 2) g.setAttribute("uv", new THREE.Float32BufferAttribute(payload.uvs, 2));
  g.setIndex(payload.indices);
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}
function primitiveGeometry(THREE, object) {
  const g = object.geometry || {};
  switch (object.primitive) {
    case "box": {
      if (g.bevelSize > 0) return geometryFromMeshPayload(THREE, buildBeveledBoxMesh({ width: g.width, height: g.height, depth: g.depth, bevel: g.bevelSize, segments: g.bevelSegments }));
      return new THREE.BoxGeometry(g.width, g.height, g.depth, g.widthSegments, g.heightSegments, g.depthSegments);
    }
    case "sphere": return new THREE.SphereGeometry(g.radius, g.widthSegments, g.heightSegments, g.phiStart, g.phiLength, g.thetaStart, g.thetaLength);
    default: break;
  }
  // Kept separate from the switch to make syntax support obvious in older JS tooling.
  if (object.primitive === "cylinder") return new THREE.CylinderGeometry(g.radiusTop, g.radiusBottom, g.height, g.radialSegments, 1, g.openEnded, g.thetaStart, g.thetaLength);
  if (object.primitive === "cone") return new THREE.ConeGeometry(g.radius, g.height, g.radialSegments, 1, g.openEnded, g.thetaStart, g.thetaLength);
  if (object.primitive === "torus") return new THREE.TorusGeometry(g.radius, g.tube, g.radialSegments, g.tubularSegments, g.arc);
  if (object.primitive === "plane") return new THREE.PlaneGeometry(g.width, g.height, g.widthSegments, g.heightSegments);
  if (object.primitive === "capsule") {
    if (typeof THREE.CapsuleGeometry === "function") return new THREE.CapsuleGeometry(g.radius, g.length, g.capSegments, g.radialSegments);
    return geometryFromMeshPayload(THREE, buildCapsuleMesh(g));
  }
  if (object.primitive === "mesh") return geometryFromMeshPayload(THREE, g);
  return null;
}

/**
 * Convert a compiled Arix3D scene into real Three.js objects. Pass the THREE
 * namespace from the app; no Three.js package is imported by this module.
 * Returns { scene, camera, objectsById, materialsById, diagnostics, dispose }.
 */
export function buildThreeScene(THREE, input, options = {}) {
  if (!isObject(THREE) || typeof THREE.Scene !== "function" || typeof THREE.Mesh !== "function") throw new TypeError("buildThreeScene requires a compatible Three.js namespace as its first argument.");
  const resolved = resolvedSceneInput(input), data = resolved.scene;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(data.environment?.background || "#f4f6f9");
  let generatedStudioEnvironment = null;
  if (options.environmentMap) scene.environment = options.environmentMap;
  else if (options.renderer && options.studioEnvironment !== false && data.environment?.studioPreset !== "none") {
    try {
      generatedStudioEnvironment = createProceduralStudioEnvironment3D(THREE, options.renderer, { backgroundColor: data.environment?.background || "#121417", softboxes: data.environment?.studioSoftboxes || [] });
      if (generatedStudioEnvironment) scene.environment = generatedStudioEnvironment;
    } catch (err) {
      if (typeof options.onWarning === "function") options.onWarning({ code: "STUDIO_ENVIRONMENT_FAILED", message: err instanceof Error ? err.message : String(err) });
    }
  }
  const materialDefs = Array.isArray(data.materials) ? data.materials : [];
  const materialsById = new Map();
  const textures = [];
  const textureFactory = options.createProceduralTextures === false ? null : (kind, cfg) => {
    const anisotropy = options.renderer?.capabilities?.getMaxAnisotropy?.() || 8;
    const maps = createProceduralTexture3D(THREE, kind, { ...cfg, maxAnisotropy: anisotropy });
    if (maps) { if (maps.map) textures.push(maps.map); if (maps.normalMap) textures.push(maps.normalMap); if (maps.roughnessMap) textures.push(maps.roughnessMap); }
    return maps;
  };
  for (const m of materialDefs) materialsById.set(m.id, normalizedMaterialForThree(THREE, m, options.environmentMap || null, textureFactory));
  if (!materialsById.has("default")) materialsById.set("default", new THREE.MeshStandardMaterial({ color: "#b8c4d6", roughness: 0.65, metalness: 0 }));
  const objectsById = new Map();
  for (const object of data.objects || []) {
    let geometry;
    try { geometry = primitiveGeometry(THREE, object); }
    catch (err) {
      if (typeof options.onWarning === "function") options.onWarning({ code: "THREE_GEOMETRY_FAILED", objectId: object.id, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!geometry) {
      if (typeof options.onWarning === "function") options.onWarning({ code: "THREE_GEOMETRY_UNAVAILABLE", objectId: object.id, message: "Geometry was empty, invalid or unsupported and was not silently substituted." });
      continue;
    }
    const material = materialsById.get(object.material) || materialsById.get("default");
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = object.name || object.id;
    mesh.position.set(...object.position); mesh.rotation.set(...object.rotation); mesh.scale.set(...object.scale);
    mesh.visible = object.visible !== false; mesh.castShadow = object.castShadow !== false; mesh.receiveShadow = Boolean(object.receiveShadow); mesh.renderOrder = object.renderOrder || 0;
    mesh.userData = { ...(isObject(object.userData) ? object.userData : {}), arix3dId: object.id, arix3dPrimitive: object.primitive, arix3dGeometryRecipe: object.geometry?.recipe || null };
    scene.add(mesh); objectsById.set(object.id, mesh);
  }
  for (const light of data.lights || []) {
    const colorValue = light.color || "#ffffff", intensity = light.intensity ?? 1;
    let obj = null;
    if (light.type === "ambient") obj = new THREE.AmbientLight(colorValue, intensity);
    else if (light.type === "directional") obj = new THREE.DirectionalLight(colorValue, intensity);
    else if (light.type === "point") obj = new THREE.PointLight(colorValue, intensity, light.distance, light.decay);
    else if (light.type === "spot") obj = new THREE.SpotLight(colorValue, intensity, light.distance, light.angle, light.penumbra, light.decay);
    else if (light.type === "hemisphere") obj = new THREE.HemisphereLight(colorValue, options.groundLightColor || "#777788", intensity);
    if (!obj) continue;
    if (obj.position && typeof obj.position.set === "function") obj.position.set(...light.position);
    obj.castShadow = Boolean(light.castShadow);
    if (obj.target && typeof obj.target.position?.set === "function") { obj.target.position.set(0, 0, 0); scene.add(obj.target); }
    scene.add(obj);
  }
  const environment = data.environment || {};
  if (environment.ground?.enabled !== false && typeof THREE.PlaneGeometry === "function") {
    const groundMaterial = new THREE.MeshStandardMaterial({ color: environment.ground?.color || "#e9edf2", roughness: 0.92, metalness: 0 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(environment.ground?.size || 100, environment.ground?.size || 100), groundMaterial);
    ground.name = "Arix3D Ground"; ground.rotation.x = -Math.PI / 2; ground.position.y = environment.ground?.y ?? -0.01; ground.receiveShadow = true; ground.userData.arix3dEnvironment = true; scene.add(ground);
  }
  // Fast procedural soft contact shadows. This is a zero-asset, radial approximation;
  // real directional shadows still come from the host renderer's shadow-map pipeline.
  const contact = environment.ground?.contactShadows;
  if (environment.ground?.enabled !== false && contact?.enabled && typeof THREE.DataTexture === "function" && typeof THREE.PlaneGeometry === "function") {
    const shadowSize = 128, data = new Uint8Array(shadowSize * shadowSize * 4);
    const sharpness = clamp(5 / (Math.max(0.1, contact.blur) + 0.5), 0.45, 8);
    for (let y = 0; y < shadowSize; y++) for (let x = 0; x < shadowSize; x++) {
      const dx = ((x + 0.5) / shadowSize) * 2 - 1, dy = ((y + 0.5) / shadowSize) * 2 - 1;
      const r = Math.hypot(dx, dy), edge = clamp((1 - r) * 5, 0, 1);
      const alpha = Math.round(clamp(Math.exp(-r * r * sharpness) * edge, 0, 1) * 255);
      const i = (y * shadowSize + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 12; data[i + 3] = alpha;
    }
    const shadowTexture = new THREE.DataTexture(data, shadowSize, shadowSize, THREE.RGBAFormat);
    shadowTexture.wrapS = shadowTexture.wrapT = THREE.ClampToEdgeWrapping;
    if (THREE.NoColorSpace !== undefined) shadowTexture.colorSpace = THREE.NoColorSpace;
    shadowTexture.needsUpdate = true; textures.push(shadowTexture);
    const groundY = environment.ground.y ?? -0.01, maxDistance = contact.maxDistance || 1.5;
    for (const object of objectsById.values()) {
      const geo = object.geometry;
      if (!geo) continue;
      if (!geo.boundingBox && typeof geo.computeBoundingBox === "function") geo.computeBoundingBox();
      const bb = geo.boundingBox;
      if (!bb?.min || !bb?.max) continue;
      const localBottom = Math.min(bb.min.y * object.scale.y, bb.max.y * object.scale.y);
      const bottomY = object.position.y + localBottom;
      const height = bottomY - groundY;
      if (height < -0.02 || height > maxDistance) continue;
      const width = Math.max(0.25, (bb.max.x - bb.min.x) * Math.abs(object.scale.x) * 1.4);
      const depth = Math.max(0.25, (bb.max.z - bb.min.z) * Math.abs(object.scale.z) * 1.4);
      const mat = new THREE.MeshBasicMaterial({ map: shadowTexture, color: "#111318", transparent: true, opacity: contact.opacity * (1 - clamp(height / maxDistance, 0, 1) * 0.85), depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 });
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), mat);
      shadow.name = `Arix3D Contact Shadow · ${object.name}`;
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.set(object.position.x, groundY + 0.002, object.position.z);
      shadow.renderOrder = 1;
      shadow.userData = { arix3dEnvironment: true, arix3dShadowFor: object.userData?.arix3dId || object.name };
      scene.add(shadow);
    }
  }
  if (environment.grid && typeof THREE.GridHelper === "function") {
    const size = environment.ground?.size || 100;
    scene.add(new THREE.GridHelper(size, Math.min(100, Math.max(10, Math.round(size))), "#b7c0cc", "#d5dae2"));
  }
  if (environment.axes && typeof THREE.AxesHelper === "function") scene.add(new THREE.AxesHelper(Math.min(10, environment.ground?.size || 10)));
  const cam = data.camera || { position: [6,5,8], target: [0,0,0], fov:45, near:0.1, far:10000, zoom:1 };
  const aspect = finite(options.aspect) && options.aspect > 0 ? options.aspect : 1;
  const camera = new THREE.PerspectiveCamera(cam.fov, aspect, cam.near, cam.far);
  camera.position.set(...cam.position); camera.zoom = cam.zoom || 1; camera.updateProjectionMatrix();
  camera.lookAt(...cam.target);
  camera.userData = camera.userData || {};
  camera.userData.arix3dDOF = cam.dof || { enabled: false }; // Host may bind this to its postprocessing DOF pass.
  const dispose = () => {
    const disposedGeometry = new Set(), disposedMaterials = new Set(), disposedTextures = new Set(textures);
    scene.traverse?.(obj => {
      if (obj.geometry && !disposedGeometry.has(obj.geometry)) { obj.geometry.dispose?.(); disposedGeometry.add(obj.geometry); }
      if (obj.material) for (const m of (Array.isArray(obj.material) ? obj.material : [obj.material])) if (m && !disposedMaterials.has(m)) {
        for (const value of Object.values(m)) if (value && typeof value.dispose === "function" && (value.isTexture || value.isWebGLRenderTarget)) disposedTextures.add(value);
        m.dispose?.(); disposedMaterials.add(m);
      }
    });
    for (const t of disposedTextures) t.dispose?.();
    if (generatedStudioEnvironment?.userData?.arix3dRenderTarget) generatedStudioEnvironment.userData.arix3dRenderTarget.dispose?.();
  };
  return { scene, camera, objectsById, materialsById, diagnostics: resolved.diagnostics, sceneSpec: data, studioEnvironment: generatedStudioEnvironment, dispose };
}

/** Set renderer tone mapping/color management from the compiled scene. */
export function applyRendererSettings3D(THREE, renderer, sceneOrInput) {
  if (!renderer || !THREE) throw new TypeError("applyRendererSettings3D requires THREE and a renderer.");
  const data = resolvedSceneInput(sceneOrInput).scene, env = data.environment || {};
  const map = { none: THREE.NoToneMapping, linear: THREE.LinearToneMapping, reinhard: THREE.ReinhardToneMapping, aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping !== undefined ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping };
  if (map[env.toneMapping] !== undefined) renderer.toneMapping = map[env.toneMapping];
  renderer.toneMappingExposure = env.exposure ?? 1;
  if ("outputColorSpace" in renderer && THREE.SRGBColorSpace !== undefined) renderer.outputColorSpace = THREE.SRGBColorSpace;
  else if ("outputEncoding" in renderer && THREE.sRGBEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
  if (renderer.shadowMap) renderer.shadowMap.enabled = true;
  return renderer;
}

/** Apply declarative animation tracks to a bundle returned by buildThreeScene. */
export function updateAnimations3D(bundle, elapsedMilliseconds = 0) {
  if (!bundle || !(bundle.objectsById instanceof Map) || !bundle.sceneSpec) return { updated: 0, skipped: 0 };
  const tracks = Array.isArray(bundle.sceneSpec.animations) ? bundle.sceneSpec.animations : [];
  const elapsed = Math.max(0, finite(elapsedMilliseconds) ? elapsedMilliseconds : 0);
  let updated = 0, skipped = 0;
  for (const track of tracks) {
    const object = bundle.objectsById.get(track.objectId);
    if (!object) { skipped++; continue; }
    const duration = Math.max(16, track.duration || 1000), repeat = track.repeat === true ? Infinity : (Number.isInteger(track.repeat) ? track.repeat : 0);
    const cycle = Math.floor(elapsed / duration);
    let progress = elapsed >= duration * (repeat + 1) ? 1 : (elapsed % duration) / duration;
    if (track.yoyo && cycle % 2 === 1 && cycle <= repeat) progress = 1 - progress;
    if (track.easing === "smoothstep") progress = progress * progress * (3 - 2 * progress);
    const value = (track.from ?? 0) + ((track.to ?? 1) - (track.from ?? 0)) * progress;
    const [group, axis] = String(track.property || "").split(".");
    const field = group === "position" ? object.position : group === "rotation" ? object.rotation : group === "scale" ? object.scale : null;
    if (!field || !["x", "y", "z"].includes(axis)) { skipped++; continue; }
    field[axis] = value; updated++;
  }
  return { updated, skipped };
}

export function createProceduralStudioEnvironment3D(THREE, renderer, studioOptions = {}) {
  if (!THREE || !renderer || typeof THREE.PMREMGenerator !== "function") return null;

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileCubemapShader?.();

  const studioScene = new THREE.Scene();
  studioScene.background = new THREE.Color(studioOptions.backgroundColor || "#121417");

  const geometries = [], materials = [];
  const addSoftbox = (pos, rot, scale, colorHex, intensity) => {
    const geom = new THREE.PlaneGeometry(1, 1);
    const col = new THREE.Color(colorHex).multiplyScalar(intensity);
    const mat = new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(...pos);
    mesh.rotation.set(...rot);
    mesh.scale.set(...scale);
    studioScene.add(mesh);
    geometries.push(geom);
    materials.push(mat);
  };

  // Prefer user-authored studio panels; fall back to a zero-network five-panel rig.
  const supplied = Array.isArray(studioOptions.softboxes) ? studioOptions.softboxes.slice(0, 12) : [];
  if (supplied.length) {
    for (const box of supplied) {
      const pos = Array.isArray(box.position) ? box.position : [0, 5, 0];
      const size = Array.isArray(box.size) ? box.size : [4, 4, 1];
      const geom = new THREE.PlaneGeometry(Math.max(0.1, size[0] || 4), Math.max(0.1, size[1] || 4));
      const col = new THREE.Color(box.color || "#ffffff").multiplyScalar(clamp(finite(box.intensity) ? box.intensity : 4, 0, 100));
      const mat = new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geom, mat); mesh.position.set(...pos); mesh.lookAt(0, 0, 0); studioScene.add(mesh); geometries.push(geom); materials.push(mat);
    }
  } else {
    addSoftbox([0, 7.5, 1.5], [Math.PI / 2.2, 0, 0], [6.5, 5.0, 1], "#fffcf5", 12.0);
    addSoftbox([-6.5, 3.0, 2.5], [0, Math.PI / 2.6, 0], [4.0, 5.5, 1], "#8eb8ff", 5.5);
    addSoftbox([6.5, 2.5, -2.0], [0, -Math.PI / 1.6, 0], [3.5, 5.0, 1], "#ffbd82", 6.5);
    addSoftbox([0, 4.5, -7.0], [Math.PI / 8, 0, 0], [8.0, 2.0, 1], "#ffffff", 8.0);
    addSoftbox([0, -4.0, 0], [-Math.PI / 2, 0, 0], [12.0, 12.0, 1], "#2a2e35", 1.4);
  }

  const renderTarget = pmremGenerator.fromScene(studioScene, 0.04);

  // Clean up temporary studio scene geometry and materials immediately
  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
  pmremGenerator.dispose();

  const texture = renderTarget.texture;
  texture.userData = texture.userData || {};
  texture.userData.arix3dRenderTarget = renderTarget;
  return texture;
}

/**
 * 3x3 Scharr Operator Height-to-Normal Extractor for Float32 Height Buffers
 */
export function buildScharrNormalTexture3D(THREE, heightField, size, normalScale = 0.2, repeatScale = 1.0) {
  if (!THREE || typeof THREE.DataTexture !== "function") return null;
  size = Math.round(clamp(finite(size) ? size : 256, 8, 1024));
  if (!heightField || heightField.length < size * size) return null;
  const data = new Uint8Array(size * size * 4);
  const strength = Math.max(0.01, normalScale) * 6.0;
  const hAt = (x, y) => heightField[((y + size) % size) * size + ((x + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = hAt(x - 1, y - 1), tc = hAt(x, y - 1), tr = hAt(x + 1, y - 1);
      const ml = hAt(x - 1, y),                         mr = hAt(x + 1, y);
      const bl = hAt(x - 1, y + 1), bc = hAt(x, y + 1), br = hAt(x + 1, y + 1);

      // 3x3 Rotational-Invariant Scharr Convolution
      const dx = ((3 * tr + 10 * mr + 3 * br) - (3 * tl + 10 * ml + 3 * bl)) / 32.0;
      const dy = ((3 * bl + 10 * bc + 3 * br) - (3 * tl + 10 * tc + 3 * tr)) / 32.0;

      let nx = -dx * strength, ny = -dy * strength, nz = 1.0;
      const len = Math.hypot(nx, ny, nz) || 1.0;
      nx /= len; ny /= len; nz /= len;

      const idx = (y * size + x) * 4;
      data[idx]     = Math.round((nx * 0.5 + 0.5) * 255);
      data[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[idx + 3] = 255;
    }
  }

  const normalMap = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.repeat?.set?.(repeatScale, repeatScale);
  // Critical PBR requirement: Normal maps must remain Linear, never sRGB
  if (THREE.NoColorSpace !== undefined) normalMap.colorSpace = THREE.NoColorSpace;
  else if (THREE.LinearSRGBColorSpace !== undefined) normalMap.colorSpace = THREE.LinearSRGBColorSpace;
  normalMap.needsUpdate = true;
  return normalMap;
}

/**
 * Create optional repeatable surface maps for a MeshStandard/PhysicalMaterial.
 * Returns null on servers or browsers without canvas support; no external image
 * or service is used. The caller owns/disposes the returned textures.
 */
export function createProceduralTexture3D(THREE, kind, options = {}) {
  if (!THREE || typeof THREE.DataTexture !== "function") return null;
  const valid = new Set(["wood", "leather", "fabric", "brushed_metal", "carbon_fiber", "concrete", "rubber", "noise"]);
  const type = cleanString(kind, "noise", 40).toLowerCase();
  if (!valid.has(type)) return null;
  const size = Math.round(clamp(finite(options.size) ? options.size : 256, 64, 1024));
  const seed = (Math.round(clamp(finite(options.seed) ? options.seed : 137, 0, 2147483647)) || 1) >>> 0;
  const scale = clamp(finite(options.scale) ? options.scale : 1, 0.01, 100);
  const grain = clamp(finite(options.grainScale) ? options.grainScale : 1, 0.01, 100);
  const base = ({ wood: [142, 94, 54], leather: [90, 61, 46], fabric: [115, 118, 122], brushed_metal: [170, 176, 182], carbon_fiber: [39, 43, 49], concrete: [132, 130, 125], rubber: [48, 49, 50], noise: [128, 128, 128] })[type];
  const mod = (v, n) => ((v % n) + n) % n;
  const hash = (x, y) => {
    let h = (Math.imul((x | 0) ^ seed, 0x45d9f3b) ^ Math.imul((y | 0) + seed, 0x27d4eb2d)) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
    return h / 4294967295;
  };
  const smooth = t => t * t * (3 - 2 * t);
  const valueNoise = (x, y, period) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x - ix), fy = smooth(y - iy);
    const a = hash(mod(ix, period), mod(iy, period)), b = hash(mod(ix + 1, period), mod(iy, period));
    const c = hash(mod(ix, period), mod(iy + 1, period)), d = hash(mod(ix + 1, period), mod(iy + 1, period));
    const u = a + (b - a) * fx, v = c + (d - c) * fx;
    return u + (v - u) * fy;
  };
  const fbm = (u, v, octaves = 5) => {
    let sum = 0, amp = 0.5, freq = 1, total = 0;
    for (let k = 0; k < octaves; k++) { sum += (valueNoise(u * freq, v * freq, Math.max(1, Math.round(size * freq))) * 2 - 1) * amp; total += amp; amp *= 0.5; freq *= 2; }
    return 0.5 + 0.5 * sum / total;
  };
  const worley = (u, v, grid) => {
    const x = u * grid, y = v * grid, ix = Math.floor(x), iy = Math.floor(y);
    let d1 = 10, d2 = 10;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox, cy = iy + oy, fx = cx + 0.15 + hash(mod(cx, grid), mod(cy, grid)) * 0.7;
      const fy = cy + 0.15 + hash(mod(cx + 31, grid), mod(cy + 73, grid)) * 0.7;
      const dx = x - fx, dy = y - fy, d = Math.hypot(dx, dy);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
    }
    return clamp((d2 - d1) / 1.2, 0, 1);
  };
  const heightField = new Float32Array(size * size);
  const pixels = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const n0 = fbm(u * scale * grain, v * scale * grain, 5);
    const cell = worley(u * scale, v * scale, Math.max(4, Math.round(18 * scale)));
    let h;
    if (type === "wood") h = 0.58 * fbm(u * scale * 2, v * scale * 24 * grain + (n0 - 0.5) * 3, 4) + 0.42 * n0;
    else if (type === "brushed_metal") h = 0.72 * fbm(u * scale * 1.5, v * scale * 75 * grain, 3) + 0.28 * n0;
    else if (type === "leather") h = 0.65 * cell + 0.35 * n0;
    else if (type === "rubber") h = 0.68 * (1 - cell) + 0.32 * n0;
    else if (type === "carbon_fiber") { const weave = ((Math.floor(u * 24 * scale) + Math.floor(v * 24 * scale)) % 2) ? 0.62 : 0.36; h = weave + 0.15 * (n0 - 0.5); }
    else if (type === "fabric") { const weave = (Math.sin(u * size * 0.65 * scale) * Math.sin(v * size * 0.65 * scale) + 1) * 0.5; h = 0.55 * weave + 0.45 * n0; }
    else if (type === "concrete") h = 0.65 * n0 + 0.35 * (1 - cell);
    else h = 0.7 * n0 + 0.3 * cell;
    h = clamp(h, 0, 1);
    heightField[y * size + x] = h;
    const detail = type === "wood" ? 0.55 + h * 0.8 : type === "brushed_metal" ? 0.72 + h * 0.42 : type === "carbon_fiber" ? 0.45 + h * 0.9 : 0.62 + h * 0.65;
    const i = (y * size + x) * 4;
    for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(clamp(base[c] * detail, 0, 255));
    pixels[i + 3] = 255;
    const roughValue = clamp(0.52 + (h - 0.5) * clamp(finite(options.roughnessVariation) ? options.roughnessVariation : 0.16, 0, 1) * 2, 0, 1);
    const rv = Math.round(roughValue * 255); rough[i] = rough[i + 1] = rough[i + 2] = rv; rough[i + 3] = 255;
  }
  const setupTexture = (data, colorSpace, filter = true) => {
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat?.set?.(scale, scale);
    if (colorSpace !== undefined) tex.colorSpace = colorSpace;
    if (THREE.LinearMipmapLinearFilter !== undefined && filter) tex.minFilter = THREE.LinearMipmapLinearFilter;
    if (THREE.LinearFilter !== undefined) tex.magFilter = THREE.LinearFilter;
    if (THREE.RepeatWrapping !== undefined) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true;
    tex.anisotropy = Math.min(8, options.maxAnisotropy || 8);
    tex.needsUpdate = true;
    return tex;
  };
  const map = setupTexture(pixels, THREE.SRGBColorSpace !== undefined ? THREE.SRGBColorSpace : undefined);
  const normalMap = buildScharrNormalTexture3D(THREE, heightField, size, clamp(finite(options.normalScale) ? options.normalScale : 0.15, 0, 4), scale);
  const roughnessMap = setupTexture(rough, THREE.NoColorSpace !== undefined ? THREE.NoColorSpace : (THREE.LinearSRGBColorSpace !== undefined ? THREE.LinearSRGBColorSpace : undefined));
  return { map, normalMap, roughnessMap, heightField };
}
