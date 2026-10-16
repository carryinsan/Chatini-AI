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

const VERSION = "3.0.0";
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
const MAX_ASSEMBLY_PARTS = 900;
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
  capsule_mesh: "capsule"
});
const MESH_RECIPES = new Set(["custom", "beveled_box", "extrude", "lathe", "sweep", "gear", "spring", "capsule"]);

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
  const keys = ["id", "name", "color", "roughness", "metalness", "opacity", "transparent", "wireframe", "side", "emissive", "emissiveIntensity", "clearcoat", "clearcoatRoughness", "sheen", "sheenRoughness", "sheenColor", "specularIntensity", "specularColor", "ior", "transmission", "thickness", "attenuationColor", "attenuationDistance", "envMapIntensity", "flatShading", "depthWrite", "depthTest", "alphaTest", "vertexColors", "preset", "proceduralTexture", "textureScale", "normalScale", "roughnessVariation", "grainScale", "seed", "anisotropy", "anisotropyRotation"];
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
    textureScale: num(obj.textureScale, 1, 0.01, 100, warnings, `${path}.textureScale`),
    normalScale: num(value("normalScale", 0.15), 0.15, 0, 4, warnings, `${path}.normalScale`),
    roughnessVariation: num(obj.roughnessVariation, 0.08, 0, 1, warnings, `${path}.roughnessVariation`),
    grainScale: num(obj.grainScale, 1, 0.01, 100, warnings, `${path}.grainScale`),
    seed: Math.round(num(obj.seed, 137, 0, 2_147_483_647, warnings, `${path}.seed`)),
    anisotropy: num(value("anisotropy", 0), 0, 0, 1, warnings, `${path}.anisotropy`),
    anisotropyRotation: num(value("anisotropyRotation", 0), 0, -Math.PI * 2, Math.PI * 2, warnings, `${path}.anisotropyRotation`)
  };
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
  const path = p.path;
  if (!Array.isArray(path) || path.length < 2 || path.length > MAX_PATH_POINTS) throw new Error("sweep recipe requires a 3D path with 2 to 4000 points.");
  const points = path.map((pt, i) => {
    if (!Array.isArray(pt) || pt.length < 3 || !pt.slice(0, 3).every(finite)) throw new Error(`Sweep path point ${i} must be [x,y,z].`);
    return pt.slice(0, 3).map(v => clamp(v, -MAX_DIMENSION, MAX_DIMENSION));
  });
  const radius = meshClamp(p.radius ?? p.tubeRadius, 0.1, MIN_DIMENSION, MAX_DIMENSION);
  const wanted = Math.round(meshClamp(p.radialSegments ?? p.segments, 12, 6, 64));
  const radial = Math.max(6, Math.min(wanted, Math.floor(MAX_MESH_VERTICES / points.length) - 1));
  const vertices = [], uvs = [], indices = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 1)];
    let tangent = next.map((v, k) => v - prev[k]);
    let tl = Math.hypot(...tangent); if (tl < 1e-10) throw new Error(`Sweep path contains a repeated/degenerate point near ${i}.`);
    tangent = tangent.map(v => v / tl);
    const ref = Math.abs(tangent[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let normal = [tangent[1] * ref[2] - tangent[2] * ref[1], tangent[2] * ref[0] - tangent[0] * ref[2], tangent[0] * ref[1] - tangent[1] * ref[0]];
    let nl = Math.hypot(...normal); normal = normal.map(v => v / nl);
    let binormal = [tangent[1] * normal[2] - tangent[2] * normal[1], tangent[2] * normal[0] - tangent[0] * normal[2], tangent[0] * normal[1] - tangent[1] * normal[0]];
    for (let j = 0; j <= radial; j++) {
      const a = j / radial * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      vertices.push(points[i][0] + radius * (normal[0] * ca + binormal[0] * sa), points[i][1] + radius * (normal[1] * ca + binormal[1] * sa), points[i][2] + radius * (normal[2] * ca + binormal[2] * sa));
      uvs.push(j / radial, i / (points.length - 1));
    }
  }
  for (let i = 0; i < points.length - 1; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b = a + radial + 1;
    indices.push(a, b, b + 1, a, b + 1, a + 1);
  }
  return { vertices, indices, uvs, recipe: "sweep", topology: "open-tube" };
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
function buildMeshRecipe(recipe, p) {
  switch (recipe) {
    case "beveled_box": return buildBeveledBoxMesh(p);
    case "extrude": return buildExtrudeMesh(p);
    case "lathe": return buildLatheMesh(p);
    case "sweep": return buildSweepMesh(p);
    case "gear": return buildGearMesh(p);
    case "spring": return buildSpringMesh(p);
    case "capsule": return buildCapsuleMesh(p);
    default: throw new Error(`Unsupported mesh recipe '${recipe}'.`);
  }
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
  if (error) {
    warnings.push({ code: "INVALID_MESH_DATA", path: `${path}.geometry`, message: error });
    return { recipe, vertices: [], indices: [], topology: "invalid", geometryError: error };
  }
  if (vertices.length / 3 > MAX_MESH_VERTICES || indices.length > MAX_MESH_INDICES) {
    warnings.push({ code: "MESH_RESOURCE_LIMIT", path: `${path}.geometry`, message: "Mesh exceeded configured vertex/index bounds and was rejected." });
    return { recipe, vertices: [], indices: [], topology: "invalid", geometryError: "MESH_RESOURCE_LIMIT" };
  }
  return { recipe, vertices, indices, ...(normals ? { normals } : {}), ...(uvs ? { uvs } : {}), topology: cleanString(built.topology, "unspecified", 40), vertexCount: vertices.length / 3, triangleCount: indices.length / 3 };
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
    mesh: ["recipe", "parameters", "vertices", "indices", "normals", "uvs", "profile", "points", "path", "width", "height", "depth", "bevel", "bevelSize", "segments", "bevelSegments", "radius", "outerRadius", "rootRadius", "boreRadius", "thickness", "teeth", "turns", "pitch", "tubeRadius", "radialSegments", "segmentsPerTurn", "capSegments"]
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
  if (MESH_PRIMITIVE_RECIPES[originalPrimitive]) {
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


/* --------------------------------------------------------------------------
 * Compound model compiler
 *
 * High-level assemblies are converted to the seven primitives supported by
 * ArixAI's current Three.js renderer. No generated JS is executed. All parts
 * remain ordinary validated scene objects, so downstream rendering stays safe.
 * -------------------------------------------------------------------------- */
function boundedInt(value, fallback, min, max) {
  return Math.round(clamp(finite(value) ? value : fallback, min, max));
}
function val(g, key, fallback, min = -MAX_ABS_COORD, max = MAX_ABS_COORD) {
  return clamp(finite(g?.[key]) ? g[key] : fallback, min, max);
}
function v3(value, fallback = [0, 0, 0]) {
  if (Array.isArray(value)) return [0, 1, 2].map(i => finite(value[i]) ? value[i] : fallback[i]);
  if (isObject(value)) return ["x", "y", "z"].map((k, i) => finite(value[k]) ? value[k] : fallback[i]);
  return [...fallback];
}
function rotateXYZ(vector, rotation) {
  const [x, y, z] = vector, [rx, ry, rz] = rotation;
  const a = Math.cos(rx), b = Math.sin(rx), c = Math.cos(ry), d = Math.sin(ry), e = Math.cos(rz), f = Math.sin(rz);
  return [
    c * e * x - c * f * y + d * z,
    (a * f + b * d * e) * x + (a * e - b * f * d) * y - b * c * z,
    (b * f - a * e * d) * x + (b * e + a * f * d) * y + a * c * z
  ];
}
function rotationMatrixXYZ(rotation) {
  const [x, y, z] = rotation;
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
  return [
    c * e, -c * f, d,
    a * f + b * d * e, a * e - b * d * f, -b * c,
    b * f - a * e * d, b * e + a * d * f, a * c
  ];
}
function composeEulerXYZ(parent, local) {
  const A = rotationMatrixXYZ(parent), B = rotationMatrixXYZ(local), M = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    M[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  }
  const sy = clamp(M[2], -1, 1), y = Math.asin(sy);
  let x, z;
  if (Math.abs(M[2]) < 0.9999999) {
    x = Math.atan2(-M[5], M[8]);
    z = Math.atan2(-M[1], M[0]);
  } else {
    x = Math.atan2(M[7], M[4]);
    z = 0;
  }
  return [x, y, z];
}
function cylinderFromTo(a, b, radius, materialKey = "default", name = "Connector") {
  const delta = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const length = Math.hypot(...delta);
  if (length < 1e-6) return null;
  const unit = delta.map(n => n / length);
  // CylinderGeometry is aligned to local +Y. This XYZ Euler rotation maps +Y
  // to the segment direction without needing a custom quaternion in JSON.
  return {
    key: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    name,
    primitive: "cylinder",
    geometry: { radiusTop: radius, radiusBottom: radius, height: length, radialSegments: 16 },
    position: a.map((n, i) => (n + b[i]) / 2),
    rotation: [Math.acos(clamp(unit[1], -1, 1)), Math.atan2(unit[0], unit[2]), 0],
    materialKey,
    scale: [1, 1, 1]
  };
}

const ASSEMBLY_NAMES = new Set([
  "rocket", "robot", "gear", "wheel", "stairs", "spring", "atom", "molecule",
  "house", "tree", "wind_turbine", "bookshelf", "car", "column", "bench", "bridge", "table", "chair",
  "airplane", "helicopter", "laptop", "satellite", "lamp", "solar_system"
]);
function normalizeAssemblyName(value) {
  return cleanString(value, "", 80).trim().toLowerCase().replace(/[\s-]+/g, "_");
}
function assemblyParts(kind, g) {
  const parts = [];
  const add = (key, name, primitive, geometry, position, rotation = [0, 0, 0], scale = [1, 1, 1], materialKey = key) => {
    if (parts.length >= MAX_ASSEMBLY_PARTS) return;
    parts.push({ key, name, primitive, geometry, position, rotation, scale, materialKey });
  };
  const box = (key, name, w, h, d, pos, rot = [0, 0, 0], mat = key) => add(key, name, "box", { width: w, height: h, depth: d }, pos, rot, [1, 1, 1], mat);
  const cyl = (key, name, rt, rb, h, pos, rot = [0, 0, 0], seg = 32, mat = key) => add(key, name, "cylinder", { radiusTop: rt, radiusBottom: rb, height: h, radialSegments: seg }, pos, rot, [1, 1, 1], mat);
  const sphere = (key, name, radius, pos, mat = key) => add(key, name, "sphere", { radius, widthSegments: 32, heightSegments: 20 }, pos, [0, 0, 0], [1, 1, 1], mat);
  const torus = (key, name, radius, tube, pos, rot = [0, 0, 0], mat = key) => add(key, name, "torus", { radius, tube, radialSegments: 20, tubularSegments: 72 }, pos, rot, [1, 1, 1], mat);

  if (kind === "rocket") {
    const r = val(g, "bodyRadius", val(g, "radius", 0.45, 0.08, 50), 0.08, 50);
    const h = val(g, "bodyHeight", val(g, "height", 4, 0.2, 500), 0.2, 500);
    const nose = val(g, "noseHeight", h * 0.32, 0.1, 200);
    const finH = val(g, "finHeight", h * 0.24, 0.08, 100);
    const finOut = val(g, "finExtension", r * 1.15, 0.05, 50);
    const finT = val(g, "finThickness", r * 0.12, 0.02, 10);
    const engineH = val(g, "engineLength", h * 0.12, 0.05, 50);
    const count = boundedInt(g.finCount, 4, 3, 8);
    cyl("body", "Rocket body", r, r, h, [0, h / 2, 0], [0, 0, 0], 64, "body");
    add("nose", "Nose cone", "cone", { radius: r, height: nose, radialSegments: 64 }, [0, h + nose / 2, 0], [0, 0, 0], [1, 1, 1], "nose");
    cyl("engine", "Engine bell", r * 0.42, r * 0.56, engineH, [0, -engineH / 2 + 0.015, 0], [0, 0, 0], 32, "engine");
    for (let i = 0; i < count; i++) {
      const a = i * Math.PI * 2 / count;
      const radial = r + finOut * 0.34;
      box(`fin_${i + 1}`, `Stabilizer fin ${i + 1}`, finOut, finH, finT, [Math.sin(a) * radial, h * 0.18, Math.cos(a) * radial], [0, a, 0], "fins");
      sphere(`port_${i + 1}`, `Hull port ${i + 1}`, r * 0.105, [Math.sin(a) * r * 0.91, h * 0.58, Math.cos(a) * r * 0.91], "ports");
    }
  } else if (kind === "robot") {
    const w = val(g, "bodyWidth", 1.25, 0.1, 100), h = val(g, "bodyHeight", 1.6, 0.1, 100), d = val(g, "bodyDepth", 0.75, 0.1, 100);
    const head = val(g, "headSize", 0.72, 0.1, 50), arm = val(g, "armLength", 1.05, 0.1, 100), leg = val(g, "legLength", 0.9, 0.1, 100);
    box("torso", "Torso", w, h, d, [0, leg + h / 2, 0], [0, 0, 0], "body");
    box("head", "Head", head, head * 0.9, head * 0.85, [0, leg + h + head * 0.55, 0], [0, 0, 0], "head");
    sphere("eye_l", "Left optical sensor", head * 0.11, [-head * 0.2, leg + h + head * 0.56, d * 0.52], "eyes");
    sphere("eye_r", "Right optical sensor", head * 0.11, [head * 0.2, leg + h + head * 0.56, d * 0.52], "eyes");
    for (const side of [-1, 1]) {
      const label = side < 0 ? "left" : "right";
      cyl(`shoulder_${label}`, `${label} shoulder joint`, w * 0.16, w * 0.16, w * 0.22, [side * (w / 2 + w * 0.08), leg + h * 0.78, 0], [0, 0, Math.PI / 2], 24, "joints");
      box(`arm_${label}`, `${label} arm`, arm, w * 0.17, w * 0.18, [side * (w / 2 + arm / 2), leg + h * 0.66, 0], [0, 0, side * -0.06], "arms");
      cyl(`hip_${label}`, `${label} hip joint`, w * 0.14, w * 0.14, w * 0.2, [side * w * 0.25, leg, 0], [0, 0, Math.PI / 2], 20, "joints");
      box(`leg_${label}`, `${label} leg`, w * 0.21, leg, d * 0.25, [side * w * 0.25, leg / 2, 0], [0, 0, 0], "legs");
      box(`foot_${label}`, `${label} foot`, w * 0.34, leg * 0.16, d * 0.58, [side * w * 0.25, leg * 0.08, d * 0.15], [0, 0, 0], "feet");
    }
  } else if (kind === "gear") {
    const r = val(g, "radius", 1.4, 0.15, 100), thick = val(g, "thickness", 0.32, 0.03, 30);
    const teeth = boundedInt(g.teeth, 16, 6, 96), toothDepth = val(g, "toothDepth", r * 0.18, 0.03, 30), toothWidth = val(g, "toothWidth", Math.max(0.04, (2 * Math.PI * r) / teeth * 0.62), 0.02, 30);
    cyl("gear_core", "Gear core", r, r, thick, [0, 0, 0], [0, 0, 0], Math.max(48, teeth * 3), "core");
    torus("rim", "Machined rim detail", r * 0.78, Math.min(thick * 0.13, r * 0.08), [0, thick * 0.42, 0], [0, 0, 0], "rim");
    for (let i = 0; i < teeth; i++) {
      const a = i * Math.PI * 2 / teeth, rr = r + toothDepth * 0.36;
      box(`tooth_${i + 1}`, `Gear tooth ${i + 1}`, toothDepth, thick * 1.02, toothWidth, [Math.sin(a) * rr, 0, Math.cos(a) * rr], [0, a, 0], "teeth");
    }
    if (g.hub !== false) cyl("hub", "Central hub", r * 0.28, r * 0.28, thick * 1.3, [0, 0, 0], [0, 0, 0], 40, "hub");
  } else if (kind === "wheel") {
    const r = val(g, "radius", 1, 0.1, 100), tube = val(g, "tube", r * 0.12, 0.02, r * 0.45);
    torus("tire", "Tire", r - tube, tube, [0, 0, 0], [Math.PI / 2, 0, 0], "tire");
    cyl("hub", "Wheel hub", r * 0.22, r * 0.22, tube * 1.8, [0, 0, 0], [Math.PI / 2, 0, 0], 40, "hub");
    const spokes = boundedInt(g.spokes, 8, 3, 32), spokeW = Math.max(0.025, tube * 0.25);
    for (let i = 0; i < spokes; i++) {
      const a = i * Math.PI * 2 / spokes, rr = r * 0.48;
      box(`spoke_${i + 1}`, `Wheel spoke ${i + 1}`, r * 0.68, spokeW, spokeW, [Math.sin(a) * rr, 0, Math.cos(a) * rr], [0, a, 0], "spokes");
    }
  } else if (kind === "stairs") {
    const count = boundedInt(g.count, 8, 1, 100), width = val(g, "width", 2, 0.1, 500), rise = val(g, "rise", 0.22, 0.02, 50), run = val(g, "run", 0.32, 0.02, 100);
    const landing = val(g, "landingDepth", run, 0, 500);
    for (let i = 0; i < count; i++) box(`step_${i + 1}`, `Step ${i + 1}`, width, rise, run + landing, [0, rise * (i + 0.5), (i + 0.5) * run], [0, 0, 0], "steps");
    const rail = g.railings === true;
    if (rail) for (const side of [-1, 1]) {
      cyl(`rail_post_${side}_0`, "Railing post at foot", 0.035, 0.035, count * rise * 0.7, [side * width * 0.46, count * rise * 0.35, 0.2], [0, 0, 0], 12, "railings");
      cyl(`rail_post_${side}_1`, "Railing post at top", 0.035, 0.035, count * rise * 0.7, [side * width * 0.46, count * rise + count * rise * 0.35, count * run], [0, 0, 0], 12, "railings");
    }
  } else if (kind === "spring") {
    const radius = val(g, "radius", 0.7, 0.03, 100), tube = val(g, "tubeRadius", 0.08, 0.005, 10);
    const turns = val(g, "turns", 5, 0.25, 20), perTurn = boundedInt(g.segmentsPerTurn, 16, 6, 32), total = Math.min(384, Math.max(6, Math.round(turns * perTurn)));
    const pitch = val(g, "pitch", 0.32, 0.02, 50), totalHeight = turns * pitch;
    let previous = null;
    for (let i = 0; i <= total; i++) {
      const a = i / total * turns * Math.PI * 2;
      const point = [radius * Math.cos(a), -totalHeight / 2 + totalHeight * i / total, radius * Math.sin(a)];
      if (previous) {
        const part = cylinderFromTo(previous, point, tube, "coil", `Coil segment ${i}`);
        if (part) parts.push(part);
      }
      previous = point;
    }
  } else if (kind === "atom" || kind === "molecule") {
    const radius = val(g, "radius", 1, 0.15, 100), atomR = val(g, "atomRadius", radius * 0.16, 0.03, radius), count = boundedInt(g.count, kind === "atom" ? 3 : 6, 1, 48);
    sphere(kind === "atom" ? "nucleus" : "central_atom", kind === "atom" ? "Nucleus" : "Central atom", atomR * 1.45, [0, 0, 0], "nucleus");
    if (kind === "atom") {
      for (let i = 0; i < count; i++) {
        const rx = i * Math.PI / Math.max(1, count), rz = i * Math.PI * 0.61803398875;
        torus(`orbital_${i + 1}`, `Electron orbital ${i + 1}`, radius, val(g, "orbitalTube", 0.018, 0.004, 2), [0, 0, 0], [rx, 0, rz], "orbitals");
        const a = i * Math.PI * 2 / count;
        sphere(`electron_${i + 1}`, `Electron ${i + 1}`, atomR * 0.44, [radius * Math.cos(a), radius * 0.15 * Math.sin(a * 2), radius * Math.sin(a)], "electrons");
      }
    } else {
      const golden = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < count; i++) {
        const y = 1 - 2 * (i + 0.5) / count, ringR = Math.sqrt(Math.max(0, 1 - y * y)), a = i * golden;
        const point = [radius * ringR * Math.cos(a), radius * y, radius * ringR * Math.sin(a)];
        const bond = cylinderFromTo([0, 0, 0], point, atomR * 0.22, "bonds", `Bond ${i + 1}`);
        if (bond) parts.push(bond);
        sphere(`atom_${i + 1}`, `Atom ${i + 1}`, atomR, point, `atom_${i % 3}`);
      }
    }
  } else if (kind === "house") {
    const w = val(g, "width", 4, 0.5, 500), d = val(g, "depth", 3.5, 0.5, 500), h = val(g, "wallHeight", 2.5, 0.4, 200), roofH = val(g, "roofHeight", 1.2, 0.2, 200), wallT = val(g, "wallThickness", 0.16, 0.03, 20);
    box("walls", "House walls", w, h, d, [0, h / 2, 0], [0, 0, 0], "walls");
    // A four-sided cone gives a clean low-poly hipped roof while remaining native-renderer compatible.
    add("roof", "Hipped roof", "cone", { radius: Math.hypot(w, d) * 0.54, height: roofH, radialSegments: 4 }, [0, h + roofH / 2, 0], [0, Math.PI / 4, 0], [1, 1, 1], "roof");
    box("door", "Front door", w * 0.18, h * 0.58, wallT * 0.35, [0, h * 0.29, d / 2 + 0.012], [0, 0, 0], "door");
    for (const side of [-1, 1]) box(`front_window_${side}`, "Front window", w * 0.18, h * 0.22, wallT * 0.35, [side * w * 0.28, h * 0.62, d / 2 + 0.012], [0, 0, 0], "windows");
    // Door/window and roof are surface overlays; Boolean wall cutouts are intentionally not faked.
  } else if (kind === "tree") {
    const trunkH = val(g, "trunkHeight", 1.8, 0.1, 100), trunkR = val(g, "trunkRadius", 0.16, 0.02, 20), canopyR = val(g, "canopyRadius", 1, 0.1, 100), tiers = boundedInt(g.tiers, 3, 1, 8);
    cyl("trunk", "Trunk", trunkR * 0.82, trunkR, trunkH, [0, trunkH / 2, 0], [0, 0, 0], 24, "trunk");
    for (let i = 0; i < tiers; i++) sphere(`canopy_${i + 1}`, `Canopy tier ${i + 1}`, canopyR * (1 - i * 0.13), [0, trunkH + canopyR * (0.45 + i * 0.52), 0], "canopy");
  } else if (kind === "wind_turbine") {
    const h = val(g, "height", 6, 1, 500), baseR = val(g, "baseRadius", 0.22, 0.04, 50), topR = val(g, "topRadius", baseR * 0.48, 0.02, 50), blade = val(g, "bladeLength", h * 0.34, 0.2, 200), bw = val(g, "bladeWidth", blade * 0.09, 0.02, 30);
    cyl("tower", "Tapered tower", topR, baseR, h, [0, h / 2, 0], [0, 0, 0], 40, "tower");
    sphere("hub", "Rotor hub", topR * 1.6, [0, h, 0], "hub");
    const count = boundedInt(g.blades, 3, 2, 6);
    for (let i = 0; i < count; i++) {
      const a = i * Math.PI * 2 / count;
      box(`blade_${i + 1}`, `Rotor blade ${i + 1}`, bw, blade, topR * 0.55, [Math.sin(a) * blade * 0.46, h + Math.cos(a) * blade * 0.46, 0], [0, 0, -a], "blades");
    }
  } else if (kind === "bookshelf") {
    const w = val(g, "width", 2.4, 0.2, 200), h = val(g, "height", 3, 0.3, 200), d = val(g, "depth", 0.45, 0.1, 100), t = val(g, "thickness", 0.08, 0.015, 10), count = boundedInt(g.shelves, 5, 2, 24);
    box("left_side", "Left side panel", t, h, d, [-w / 2 + t / 2, h / 2, 0], [0, 0, 0], "frame");
    box("right_side", "Right side panel", t, h, d, [w / 2 - t / 2, h / 2, 0], [0, 0, 0], "frame");
    box("back", "Back panel", w - 2 * t, h, t * 0.45, [0, h / 2, -d / 2 + t * 0.2], [0, 0, 0], "back");
    for (let i = 0; i < count; i++) box(`shelf_${i + 1}`, `Shelf ${i + 1}`, w, t, d, [0, (i + 1) * h / (count + 1), 0], [0, 0, 0], "shelves");
  } else if (kind === "car") {
    const w = val(g, "width", 1.8, 0.4, 100), h = val(g, "bodyHeight", 0.65, 0.15, 30), length = val(g, "length", 4, 0.8, 200), wheelR = val(g, "wheelRadius", 0.42, 0.08, 20), tireT = val(g, "wheelWidth", 0.22, 0.04, 10);
    box("chassis", "Vehicle chassis", length, h, w, [0, wheelR + h * 0.4, 0], [0, 0, 0], "body");
    box("cabin", "Cabin", length * 0.48, h * 1.12, w * 0.78, [-length * 0.12, wheelR + h * 1.36, 0], [0, 0, 0], "cabin");
    for (const xSide of [-1, 1]) for (const zSide of [-1, 1]) {
      const key = `wheel_${xSide < 0 ? "rear" : "front"}_${zSide < 0 ? "left" : "right"}`;
      torus(key, key.replace(/_/g, " "), wheelR * 0.78, tireT, [xSide * length * 0.31, wheelR, zSide * (w / 2 + tireT * 0.28)], [Math.PI / 2, 0, 0], "tires");
      cyl(`${key}_hub`, "Wheel hub", wheelR * 0.24, wheelR * 0.24, tireT * 1.2, [xSide * length * 0.31, wheelR, zSide * (w / 2 + tireT * 0.28)], [Math.PI / 2, 0, 0], 24, "hubs");
    }
    for (const side of [-1, 1]) sphere(`headlamp_${side}`, "Headlamp", h * 0.12, [length * 0.49, wheelR + h * 0.55, side * w * 0.29], "lights");
  } else if (kind === "column") {
    const h = val(g, "height", 3, 0.2, 200), r = val(g, "radius", 0.35, 0.05, 50), cap = val(g, "capitalHeight", h * 0.08, 0.02, 20), base = val(g, "baseHeight", h * 0.08, 0.02, 20);
    cyl("shaft", "Column shaft", r * 0.84, r, h - cap - base, [0, h / 2, 0], [0, 0, 0], 48, "shaft");
    cyl("base", "Column base", r * 1.4, r * 1.25, base, [0, base / 2, 0], [0, 0, 0], 48, "base");
    cyl("capital", "Column capital", r * 1.45, r * 0.84, cap, [0, h - cap / 2, 0], [0, 0, 0], 48, "capital");
  } else if (kind === "bench") {
    const w = val(g, "width", 2.2, 0.3, 100), d = val(g, "depth", 0.5, 0.15, 30), seatH = val(g, "seatHeight", 0.48, 0.1, 20), backH = val(g, "backHeight", 0.7, 0.1, 30), t = val(g, "thickness", 0.07, 0.015, 5);
    box("seat", "Seat", w, t, d, [0, seatH, 0], [0, 0, 0], "seat");
    for (const side of [-1, 1]) {
      box(`leg_${side}`, "Bench leg", t * 1.5, seatH, t * 1.5, [side * w * 0.4, seatH / 2, 0], [0, 0, 0], "frame");
      box(`back_support_${side}`, "Back support", t, backH, t, [side * w * 0.4, seatH + backH / 2, -d * 0.38], [0, 0, 0], "frame");
    }
    for (let i = 0; i < 3; i++) box(`back_slats_${i + 1}`, `Back slat ${i + 1}`, w, t, t, [0, seatH + backH * (0.25 + i * 0.3), -d * 0.38], [0, 0, 0], "back");
  } else if (kind === "bridge") {
    const length = val(g, "length", 8, 1, 500), width = val(g, "width", 2, 0.2, 100), h = val(g, "height", 2, 0.2, 100), pillars = boundedInt(g.pillars, 4, 2, 32), t = val(g, "thickness", 0.18, 0.04, 20);
    box("deck", "Bridge deck", length, t, width, [0, h, 0], [0, 0, 0], "deck");
    box("rail_left", "Left safety rail", length, h * 0.12, t * 0.55, [0, h + h * 0.45, -width * 0.45], [0, 0, 0], "rails");
    box("rail_right", "Right safety rail", length, h * 0.12, t * 0.55, [0, h + h * 0.45, width * 0.45], [0, 0, 0], "rails");
    for (let i = 0; i < pillars; i++) {
      const x = -length / 2 + (length * i) / (pillars - 1);
      cyl(`pier_${i + 1}`, `Bridge pier ${i + 1}`, t, t * 1.2, h, [x, h / 2, 0], [0, 0, 0], 24, "piers");
    }
  } else if (kind === "airplane") {
    const length = val(g, "length", 5, 0.5, 300), span = val(g, "wingspan", 6, 0.5, 500), fuselageR = val(g, "fuselageRadius", 0.22, 0.04, 30), wingChord = val(g, "wingChord", 0.75, 0.08, 80), wingT = val(g, "wingThickness", 0.12, 0.02, 20);
    cyl("fuselage", "Fuselage", fuselageR, fuselageR * 0.86, length * 0.72, [0, 0, 0], [Math.PI / 2, 0, 0], 40, "fuselage");
    add("nose", "Nose", "cone", { radius: fuselageR, height: length * 0.28, radialSegments: 40 }, [0, 0, length * 0.5], [Math.PI / 2, 0, 0], [1, 1, 1], "nose");
    box("main_wing", "Main wing", span, wingT, wingChord, [0, 0, length * 0.02], [0, 0, 0], "wings");
    box("tailplane", "Horizontal tailplane", span * 0.36, wingT * 0.8, wingChord * 0.42, [0, 0, -length * 0.34], [0, 0, 0], "wings");
    box("fin", "Vertical tail fin", wingT, length * 0.18, wingChord * 0.35, [0, length * 0.08, -length * 0.34], [0, 0, 0], "fin");
    const engines = boundedInt(g.engines, 2, 1, 4);
    for (let i = 0; i < engines; i++) {
      const side = engines === 1 ? 0 : (i % 2 ? 1 : -1), row = Math.floor(i / 2);
      cyl(`engine_${i + 1}`, `Engine ${i + 1}`, fuselageR * 0.32, fuselageR * 0.32, length * 0.16, [side * span * (engines > 2 ? 0.22 + row * 0.12 : 0.23), -wingT * 0.1, -length * 0.03], [Math.PI / 2, 0, 0], 24, "engines");
    }
  } else if (kind === "helicopter") {
    const length = val(g, "length", 2.7, 0.5, 200), w = val(g, "width", 1.1, 0.2, 80), bodyH = val(g, "bodyHeight", 0.95, 0.2, 60), tail = val(g, "tailLength", 2.2, 0.3, 200), rotor = val(g, "rotorLength", 3.2, 0.5, 300);
    sphere("fuselage", "Helicopter fuselage", Math.max(w, bodyH) * 0.55, [0, 0, 0], "body");
    box("tail_boom", "Tail boom", tail, bodyH * 0.16, bodyH * 0.16, [0, bodyH * 0.08, -length * 0.35 - tail * 0.45], [0, 0, 0], "tail");
    cyl("mast", "Main rotor mast", bodyH * 0.07, bodyH * 0.07, bodyH * 0.68, [0, bodyH * 0.78, 0], [0, 0, 0], 20, "mast");
    const n = boundedInt(g.rotorBlades, 4, 2, 8);
    for (let i = 0; i < n; i++) {
      const a = i * Math.PI * 2 / n;
      box(`main_blade_${i + 1}`, `Main rotor blade ${i + 1}`, rotor * 0.54, bodyH * 0.045, bodyH * 0.09, [Math.sin(a) * rotor * 0.27, bodyH * 1.16, Math.cos(a) * rotor * 0.27], [0, a, 0], "rotor");
    }
    sphere("tail_rotor_hub", "Tail rotor hub", bodyH * 0.12, [0, bodyH * 0.12, -length * 0.35 - tail], "tail_rotor");
    box("tail_rotor_a", "Tail rotor blade A", bodyH * 0.06, rotor * 0.18, bodyH * 0.035, [0, bodyH * 0.12, -length * 0.35 - tail], [0, 0, 0], "tail_rotor");
    box("tail_rotor_b", "Tail rotor blade B", rotor * 0.18, bodyH * 0.06, bodyH * 0.035, [0, bodyH * 0.12, -length * 0.35 - tail], [0, 0, 0], "tail_rotor");
  } else if (kind === "laptop") {
    const w = val(g, "width", 1.3, 0.3, 80), d = val(g, "depth", 0.9, 0.2, 80), baseT = val(g, "baseThickness", 0.07, 0.015, 5), screenH = val(g, "screenHeight", 0.9, 0.2, 60), screenT = val(g, "screenThickness", 0.045, 0.01, 5), angle = val(g, "screenAngle", 0.2, -1.2, 1.2);
    box("base", "Laptop base", w, baseT, d, [0, baseT / 2, 0], [0, 0, 0], "body");
    box("keyboard", "Keyboard deck", w * 0.82, baseT * 0.12, d * 0.48, [0, baseT * 1.06, d * 0.04], [0, 0, 0], "keyboard");
    box("trackpad", "Trackpad", w * 0.25, baseT * 0.13, d * 0.22, [0, baseT * 1.08, d * 0.28], [0, 0, 0], "trackpad");
    box("display_frame", "Display frame", w, screenH, screenT, [0, baseT + screenH * Math.cos(angle) / 2, -d * 0.48 - screenH * Math.sin(angle) / 2], [-angle, 0, 0], "frame");
    box("display", "Display panel", w * 0.9, screenH * 0.88, screenT * 0.18, [0, baseT + screenH * Math.cos(angle) / 2, -d * 0.48 - screenH * Math.sin(angle) / 2 + screenT * 0.56], [-angle, 0, 0], "screen");
  } else if (kind === "satellite") {
    const w = val(g, "busSize", 0.8, 0.1, 80), panel = val(g, "panelSpan", 2.4, 0.2, 200), panelW = val(g, "panelWidth", 0.75, 0.1, 100), t = val(g, "panelThickness", 0.035, 0.005, 5);
    box("bus", "Satellite bus", w, w, w, [0, 0, 0], [0, 0, 0], "bus");
    for (const side of [-1, 1]) {
      box(`solar_panel_${side}`, "Solar panel array", panel / 2, panelW, t, [side * (w / 2 + panel / 4), 0, 0], [0, 0, 0], "panels");
      for (let i = 0; i < 4; i++) box(`panel_cell_${side}_${i}`, "Solar-cell stripe", panel / 2 * 0.94, panelW * 0.08, t * 1.08, [side * (w / 2 + panel / 4), -panelW * 0.36 + i * panelW * 0.24, t * 0.08], [0, 0, 0], "cells");
    }
    cyl("antenna_mast", "Antenna mast", 0.025, 0.025, w * 1.2, [0, w * 0.8, 0], [0, 0, 0], 12, "antenna");
    sphere("antenna_dish", "Antenna dish", w * 0.28, [0, w * 1.4, 0], "antenna");
  } else if (kind === "lamp") {
    const h = val(g, "height", 1.8, 0.2, 100), baseR = val(g, "baseRadius", 0.28, 0.05, 20), stemR = val(g, "stemRadius", baseR * 0.12, 0.01, 5), shadeH = val(g, "shadeHeight", h * 0.25, 0.05, 40), shadeR = val(g, "shadeRadius", baseR * 1.9, 0.05, 50);
    cyl("base", "Lamp base", baseR * 0.94, baseR, h * 0.08, [0, h * 0.04, 0], [0, 0, 0], 40, "base");
    cyl("stem", "Lamp stem", stemR, stemR, h * 0.68, [0, h * 0.42, 0], [0, 0, 0], 24, "stem");
    cyl("shade", "Lamp shade", shadeR * 0.28, shadeR, shadeH, [0, h - shadeH / 2, 0], [0, 0, 0], 48, "shade");
    sphere("bulb", "Bulb", shadeR * 0.18, [0, h - shadeH * 0.75, 0], "bulb");
  } else if (kind === "solar_system") {
    const orbitBase = val(g, "orbitBase", 1.5, 0.3, 300), count = boundedInt(g.planetCount, 8, 1, 12), starR = val(g, "starRadius", 0.42, 0.05, 50), tube = val(g, "orbitTube", 0.012, 0.002, 2);
    sphere("star", "Central star", starR, [0, 0, 0], "star");
    for (let i = 0; i < count; i++) {
      const orbit = orbitBase + i * orbitBase * 0.48;
      const radiusList = Array.isArray(g.planetRadii) ? g.planetRadii : [];
      const planetR = val({ radius: radiusList[i] }, "radius", Math.max(0.06, 0.15 - i * 0.008), 0.025, starR * 1.5);
      torus(`orbit_${i + 1}`, `Orbit ${i + 1}`, orbit, tube, [0, 0, 0], [Math.PI / 2, 0, 0], "orbits");
      const a = i * 2.399963229728653, point = [orbit * Math.cos(a), (i % 3 - 1) * orbit * 0.035, orbit * Math.sin(a)];
      sphere(`planet_${i + 1}`, `Planet ${i + 1}`, planetR, point, `planet_${i % 5}`);
      if (i === 2) torus(`planet_ring_${i + 1}`, "Planetary ring", planetR * 1.5, planetR * 0.08, point, [Math.PI / 3, 0, 0], "planet_rings");
    }
  } else if (kind === "table") {
    const w = val(g, "width", 2, 0.3, 200), d = val(g, "depth", 1.2, 0.2, 200), h = val(g, "height", 0.76, 0.2, 100), t = val(g, "topThickness", 0.09, 0.02, 10), legR = val(g, "legRadius", 0.055, 0.015, 10), inset = val(g, "legInset", 0.13, 0.02, Math.min(w, d) / 2);
    box("top", "Tabletop", w, t, d, [0, h - t / 2, 0], [0, 0, 0], "top");
    const legH = h - t;
    for (const x of [-1, 1]) for (const z of [-1, 1]) cyl(`leg_${x}_${z}`, "Table leg", legR, legR * 1.05, legH, [x * (w / 2 - inset), legH / 2, z * (d / 2 - inset)], [0, 0, 0], 20, "legs");
  } else if (kind === "chair") {
    const w = val(g, "width", 0.52, 0.2, 100), d = val(g, "depth", 0.5, 0.2, 100), seatH = val(g, "seatHeight", 0.48, 0.1, 20), backH = val(g, "backHeight", 0.82, 0.1, 30), t = val(g, "thickness", 0.06, 0.015, 5), legR = val(g, "legRadius", 0.035, 0.01, 5);
    box("seat", "Chair seat", w, t, d, [0, seatH, 0], [0, 0, 0], "seat");
    for (const x of [-1, 1]) for (const z of [-1, 1]) cyl(`leg_${x}_${z}`, "Chair leg", legR, legR, seatH - t / 2, [x * w * 0.4, (seatH - t / 2) / 2, z * d * 0.4], [0, 0, 0], 16, "legs");
    box("back", "Chair backrest", w, backH, t, [0, seatH + backH / 2, -d / 2 + t / 2], [0, 0, 0], "back");
    if (g.slattedBack === true) for (let i = 0; i < 4; i++) box(`slat_${i + 1}`, `Backrest slat ${i + 1}`, w * 0.92, t * 0.8, t * 1.1, [0, seatH + backH * (0.18 + i * 0.2), -d / 2], [0, 0, 0], "back");
  }
  return parts;
}

function expandAssemblies(rawObjects, globalWarnings) {
  const output = [];
  const pushOrdinary = (obj) => {
    if (output.length < MAX_EXPANDED_OBJECTS) output.push(obj);
  };
  for (let i = 0; i < rawObjects.length && output.length < MAX_EXPANDED_OBJECTS; i++) {
    const raw = rawObjects[i];
    if (!isObject(raw)) {
      globalWarnings.push({ code: "INVALID_OBJECT", path: `objects[${i}]`, message: "Non-object scene entry was ignored." });
      continue;
    }
    const assemblyDef = isObject(raw.assembly) ? raw.assembly : null;
    const kind = normalizeAssemblyName(assemblyDef?.type ?? (typeof raw.assembly === "string" ? raw.assembly : raw.model ?? raw.blueprint ?? raw.primitive ?? raw.type));
    if (!ASSEMBLY_NAMES.has(kind)) {
      const copy = { ...raw };
      if (assemblyDef) {
        delete copy.assembly;
        if (!copy.primitive && !copy.type) copy.primitive = "box";
        globalWarnings.push({ code: "UNKNOWN_ASSEMBLY", path: `objects[${i}].assembly`, message: `Unknown assembly '${kind}' was not expanded; provide a supported primitive or assembly name.` });
      }
      pushOrdinary(copy);
      continue;
    }
    const parentId = cleanString(raw.id, `assembly_${i + 1}`, 80).replace(/[^a-zA-Z0-9_.:-]/g, "_");
    const geometry = {
      ...(isObject(raw.geometry) ? raw.geometry : {}),
      ...(isObject(raw.parameters) ? raw.parameters : {}),
      ...(assemblyDef ? Object.fromEntries(Object.entries(assemblyDef).filter(([k]) => k !== "type")) : {})
    };
    const parts = assemblyParts(kind, geometry);
    if (!parts.length) {
      globalWarnings.push({ code: "ASSEMBLY_EMPTY", path: `objects[${i}]`, message: `Assembly '${kind}' produced no parts.` });
      continue;
    }
    if (parts.length >= MAX_ASSEMBLY_PARTS) globalWarnings.push({ code: "ASSEMBLY_PART_LIMIT", path: `objects[${i}]`, message: `Assembly '${kind}' reached its part limit.` });
    const parentPosition = v3(raw.position), parentRotation = v3(raw.rotation), parentScale = v3(raw.scale, [1, 1, 1]);
    const partMaterials = isObject(raw.partMaterials) ? raw.partMaterials : (isObject(assemblyDef?.partMaterials) ? assemblyDef.partMaterials : {});
    for (let j = 0; j < parts.length && output.length < MAX_EXPANDED_OBJECTS; j++) {
      const part = parts[j];
      const scaledLocal = part.position.map((n, axis) => n * parentScale[axis]);
      const rotated = rotateXYZ(scaledLocal, parentRotation);
      const targetPosition = rotated.map((n, axis) => n + parentPosition[axis]);
      const targetRotation = composeEulerXYZ(parentRotation, part.rotation);
      const nonUniformScale = Math.max(...parentScale) - Math.min(...parentScale) > 1e-8;
      const rotatedChild = part.rotation.some(v => Math.abs(v) > 1e-8);
      if (nonUniformScale && rotatedChild && j === 0) {
        globalWarnings.push({ code: "NONUNIFORM_PARENT_SCALE", path: `objects[${i}].scale`, message: "A rotated assembly part under non-uniform parent scale may require shear, which position/rotation/scale scene formats cannot represent exactly. Prefer uniform parent scale for maximum geometric fidelity." });
      }
      const targetScale = part.scale.map((n, axis) => n * parentScale[axis]);
      const selectedMaterial = typeof partMaterials[part.materialKey] === "string" ? partMaterials[part.materialKey] : (typeof raw.material === "string" ? raw.material : "default");
      output.push({
        id: `${parentId}_${part.key || `part_${j + 1}`}`,
        name: `${cleanString(raw.name, kind.replace(/_/g, " "), 100)} · ${part.name || part.key}`,
        primitive: part.primitive,
        geometry: part.geometry,
        position: targetPosition,
        rotation: targetRotation,
        scale: targetScale,
        material: selectedMaterial,
        visible: raw.visible !== false,
        castShadow: raw.castShadow !== false,
        receiveShadow: Boolean(raw.receiveShadow),
        userData: { ...(isObject(raw.userData) ? raw.userData : {}), assembly: kind, assemblyParent: parentId, part: part.key || `part_${j + 1}` }
      });
    }
    globalWarnings.push({ code: "ASSEMBLY_EXPANDED", severity: "info", path: `objects[${i}]`, message: `Expanded '${kind}' into ${parts.length} renderer-compatible parts. Boolean cutouts and physical simulations are not implied.` });
  }
  if (rawObjects.length && output.length >= MAX_EXPANDED_OBJECTS) {
    globalWarnings.push({ code: "EXPANDED_OBJECT_LIMIT", path: "objects", message: `Scene truncated at ${MAX_EXPANDED_OBJECTS} expanded objects to protect memory and render performance.` });
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
  const top = safeObject(raw, ["version", "title", "units", "camera", "environment", "materials", "lights", "objects", "animations", "metadata", "constraints", "modeling", "quality", "precision"], warnings, "scene");
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
 * Create a convenient high-level assembly object. Pass the result through
 * compile3D() like any other scene object. All geometry remains declarative.
 */
export function createAssembly(type, options = {}) {
  const opts = isObject(options) ? options : {};
  const kind = normalizeAssemblyName(type);
  if (!ASSEMBLY_NAMES.has(kind)) {
    return { ok: false, error: `Unsupported assembly '${kind}'.`, supported: [...ASSEMBLY_NAMES].sort() };
  }
  return { ok: true, object: { id: opts.id || `${kind}_1`, name: opts.name || kind.replace(/_/g, " "), assembly: { type: kind, ...(isObject(opts.geometry) ? opts.geometry : {}) }, ...(opts.position !== undefined ? { position: opts.position } : {}), ...(opts.rotation !== undefined ? { rotation: opts.rotation } : {}), ...(opts.scale !== undefined ? { scale: opts.scale } : {}), ...(opts.material ? { material: opts.material } : {}), ...(opts.partMaterials ? { partMaterials: opts.partMaterials } : {}) } };
}

/** Machine-readable list of built-in compound assemblies and aliases. */
export function capabilities3D() {
  return {
    compilerVersion: VERSION,
    primitives: [...BASE_PRIMITIVES, "mesh"].sort(),
    meshRecipes: [...MESH_RECIPES].sort(),
    materialPresets: Object.keys(MATERIAL_PRESETS).sort(),
    aliases: { ...PRIMITIVE_ALIASES },
    assemblies: [...ASSEMBLY_NAMES].sort(),
    maxInputCharacters: MAX_INPUT_CHARS,
    maxInputObjects: MAX_OBJECTS,
    maxExpandedObjects: MAX_EXPANDED_OBJECTS,
    security: { executesGeneratedCode: false, acceptsDeclarativeSceneData: true, meshVertexLimit: MAX_MESH_VERTICES, meshIndexLimit: MAX_MESH_INDICES },
    rendererHelpers: ["buildThreeScene", "applyRendererSettings3D", "updateAnimations3D", "createProceduralTexture3D"]
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
  if (options.environmentMap) scene.environment = options.environmentMap;
  const materialDefs = Array.isArray(data.materials) ? data.materials : [];
  const materialsById = new Map();
  const textures = [];
  const textureFactory = options.createProceduralTextures === false ? null : (kind, cfg) => {
    const maps = createProceduralTexture3D(THREE, kind, cfg);
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
  };
  return { scene, camera, objectsById, materialsById, diagnostics: resolved.diagnostics, sceneSpec: data, dispose };
}

/** Set renderer tone mapping/color management from the compiled scene. */
export function applyRendererSettings3D(THREE, renderer, sceneOrInput) {
  if (!renderer || !THREE) throw new TypeError("applyRendererSettings3D requires THREE and a renderer.");
  const data = resolvedSceneInput(sceneOrInput).scene, env = data.environment || {};
  const map = { none: THREE.NoToneMapping, linear: THREE.LinearToneMapping, reinhard: THREE.ReinhardToneMapping, aces: THREE.ACESFilmicToneMapping };
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

/**
 * Create optional repeatable surface maps for a MeshStandard/PhysicalMaterial.
 * Returns null on servers or browsers without canvas support; no external image
 * or service is used. The caller owns/disposes the returned textures.
 */
export function createProceduralTexture3D(THREE, kind, options = {}) {
  if (!THREE || typeof THREE.CanvasTexture !== "function" || typeof document === "undefined" || typeof document.createElement !== "function") return null;
  const valid = new Set(["wood", "leather", "fabric", "brushed_metal", "carbon_fiber", "concrete", "rubber", "noise"]);
  const type = cleanString(kind, "noise", 40).toLowerCase(); if (!valid.has(type)) return null;
  const size = Math.round(clamp(finite(options.size) ? options.size : 256, 64, 1024));
  const canvas = document.createElement("canvas"); canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true }); if (!ctx) return null;
  let seed = Math.round(clamp(finite(options.seed) ? options.seed : 137, 0, 2_147_483_647)) || 1;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const scale = clamp(finite(options.scale) ? options.scale : 1, 0.01, 100), grain = clamp(finite(options.grainScale) ? options.grainScale : 1, 0.01, 100);
  ctx.fillStyle = type === "wood" ? "#9a6b3f" : type === "leather" ? "#5c4033" : type === "fabric" ? "#777777" : type === "brushed_metal" ? "#aaaaaa" : type === "carbon_fiber" ? "#30343a" : type === "concrete" ? "#888888" : type === "rubber" ? "#333333" : "#808080";
  ctx.fillRect(0, 0, size, size);
  if (type === "wood") {
    for (let i = 0; i < 180 * Math.min(2, grain); i++) { const y = rand() * size, amp = 1 + rand() * size * 0.012; ctx.strokeStyle = `rgba(${40+Math.round(rand()*50)},${22+Math.round(rand()*30)},${8+Math.round(rand()*15)},${0.08+rand()*0.2})`; ctx.lineWidth = 0.5 + rand() * 2; ctx.beginPath(); ctx.moveTo(0, y); for (let x = 0; x <= size; x += 8) ctx.lineTo(x, y + Math.sin((x / size * 10 + rand()) * Math.PI) * amp); ctx.stroke(); }
  } else if (type === "fabric" || type === "carbon_fiber") {
    const cell = Math.max(2, Math.round((type === "carbon_fiber" ? 12 : 5) / Math.min(2, scale)));
    for (let y = 0; y < size; y += cell) for (let x = 0; x < size; x += cell) {
      const bright = Math.round(25 + rand() * (type === "carbon_fiber" ? 45 : 35)); ctx.fillStyle = `rgb(${bright},${bright},${bright})`;
      ctx.fillRect(x + (type === "carbon_fiber" && Math.floor(y / cell) % 2 ? cell/2 : 0), y, cell/2, cell);
      ctx.fillRect(x, y, cell, cell/2);
    }
  } else if (type === "brushed_metal") {
    for (let i = 0; i < size * 3; i++) { const y = rand() * size; const v = 100 + Math.round(rand() * 100); ctx.strokeStyle = `rgba(${v},${v},${v},${0.08 + rand()*0.2})`; ctx.lineWidth = 0.4 + rand() * 0.8; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y + (rand()-0.5)*1.5); ctx.stroke(); }
  } else if (type === "leather" || type === "rubber") {
    const gap = Math.max(3, Math.round((type === "leather" ? 7 : 13) / Math.min(2, scale)));
    for (let y = 0; y < size; y += gap) for (let x = 0; x < size; x += gap) { const r = type === "leather" ? 0.5 + rand() * 1.4 : 0.7 + rand() * 1.2; ctx.fillStyle = `rgba(0,0,0,${0.06+rand()*0.22})`; ctx.beginPath(); ctx.arc(x + rand()*gap, y + rand()*gap, r, 0, Math.PI*2); ctx.fill(); }
  } else {
    const img = ctx.getImageData(0, 0, size, size);
    for (let i = 0; i < img.data.length; i += 4) { const n = (rand()-0.5) * (type === "concrete" ? 70 : 28); for (let c = 0; c < 3; c++) img.data[i+c] = clamp(img.data[i+c] + n, 0, 255); }
    ctx.putImageData(img, 0, 0);
  }
  const map = new THREE.CanvasTexture(canvas);
  if (THREE.RepeatWrapping !== undefined) { map.wrapS = map.wrapT = THREE.RepeatWrapping; map.repeat?.set?.(Math.max(0.01, scale), Math.max(0.01, scale)); }
  if (THREE.SRGBColorSpace !== undefined) map.colorSpace = THREE.SRGBColorSpace;
  else if (THREE.sRGBEncoding !== undefined) map.encoding = THREE.sRGBEncoding;
  map.needsUpdate = true;
  // Derive a real normal map from the luminance height field; this is repeatable and bounded.
  const height = ctx.getImageData(0, 0, size, size), normalCanvas = document.createElement("canvas"); normalCanvas.width = size; normalCanvas.height = size;
  const nctx = normalCanvas.getContext("2d"); let normalMap = null;
  if (nctx) {
    const out = nctx.createImageData(size, size), strength = clamp(finite(options.normalScale) ? options.normalScale : 0.15, 0, 4) * 4;
    const hAt = (x, y) => { const k = ((y+size)%size*size + (x+size)%size)*4; return (height.data[k]+height.data[k+1]+height.data[k+2])/3; };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const k = (y*size+x)*4, dx = (hAt(x+1,y)-hAt(x-1,y))*strength/255, dy = (hAt(x,y+1)-hAt(x,y-1))*strength/255;
      let nx = -dx, ny = -dy, nz = 1, len = Math.hypot(nx,ny,nz); nx/=len; ny/=len; nz/=len;
      out.data[k]=Math.round((nx*0.5+0.5)*255); out.data[k+1]=Math.round((ny*0.5+0.5)*255); out.data[k+2]=Math.round((nz*0.5+0.5)*255); out.data[k+3]=255;
    }
    nctx.putImageData(out,0,0); normalMap = new THREE.CanvasTexture(normalCanvas);
    if (THREE.RepeatWrapping !== undefined) { normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping; normalMap.repeat?.set?.(Math.max(0.01,scale),Math.max(0.01,scale)); }
    normalMap.needsUpdate = true;
  }
  const roughCanvas = document.createElement("canvas"); roughCanvas.width = size; roughCanvas.height = size;
  const rctx = roughCanvas.getContext("2d"); let roughnessMap = null;
  if (rctx) {
    const src = ctx.getImageData(0, 0, size, size), out = rctx.createImageData(size, size);
    const variation = clamp(finite(options.roughnessVariation) ? options.roughnessVariation : 0.08, 0, 1);
    for (let i = 0; i < src.data.length; i += 4) {
      const lum = (src.data[i] * 0.2126 + src.data[i+1] * 0.7152 + src.data[i+2] * 0.0722) / 255;
      const value = Math.round(clamp(0.72 + (lum - 0.5) * variation, 0, 1) * 255);
      out.data[i] = out.data[i+1] = out.data[i+2] = value; out.data[i+3] = 255;
    }
    rctx.putImageData(out, 0, 0); roughnessMap = new THREE.CanvasTexture(roughCanvas);
    if (THREE.RepeatWrapping !== undefined) { roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping; roughnessMap.repeat?.set?.(Math.max(0.01,scale),Math.max(0.01,scale)); }
    roughnessMap.needsUpdate = true;
  }
  return { map, normalMap, roughnessMap };
}
