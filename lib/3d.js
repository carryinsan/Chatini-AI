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

const VERSION = "2.5.0";
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

function normalizeMaterial(raw, index, seen, warnings) {
  const path = `materials[${index}]`;
  const obj = safeObject(raw, ["id", "name", "color", "roughness", "metalness", "opacity", "transparent", "wireframe", "side", "emissive", "emissiveIntensity", "clearcoat", "clearcoatRoughness", "sheen", "sheenRoughness", "sheenColor", "specularIntensity", "specularColor", "ior", "transmission", "thickness", "attenuationColor", "attenuationDistance", "envMapIntensity", "flatShading", "depthWrite", "depthTest", "alphaTest", "vertexColors"], warnings, path);
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
    emissiveIntensity: num(obj.emissiveIntensity, 0, 0, 10, warnings, `${path}.emissiveIntensity`),
    // Extended PBR fields are preserved for renderers that support them; the bundled app's
    // current MeshStandardMaterial renderer consumes the core fields above.
    clearcoat: num(obj.clearcoat, 0, 0, 1, warnings, `${path}.clearcoat`),
    clearcoatRoughness: num(obj.clearcoatRoughness, 0.1, 0, 1, warnings, `${path}.clearcoatRoughness`),
    sheen: num(obj.sheen, 0, 0, 1, warnings, `${path}.sheen`),
    sheenRoughness: num(obj.sheenRoughness, 0.5, 0, 1, warnings, `${path}.sheenRoughness`),
    sheenColor: color(obj.sheenColor, "#ffffff", warnings, `${path}.sheenColor`),
    specularIntensity: num(obj.specularIntensity, 1, 0, 1, warnings, `${path}.specularIntensity`),
    specularColor: color(obj.specularColor, "#ffffff", warnings, `${path}.specularColor`),
    ior: num(obj.ior, 1.5, 1, 2.333, warnings, `${path}.ior`),
    transmission: num(obj.transmission, 0, 0, 1, warnings, `${path}.transmission`),
    thickness: num(obj.thickness, 0, 0, MAX_DIMENSION, warnings, `${path}.thickness`),
    attenuationColor: color(obj.attenuationColor, "#ffffff", warnings, `${path}.attenuationColor`),
    attenuationDistance: num(obj.attenuationDistance, 0, 0, MAX_DIMENSION, warnings, `${path}.attenuationDistance`),
    envMapIntensity: num(obj.envMapIntensity, 1, 0, 100, warnings, `${path}.envMapIntensity`),
    flatShading: Boolean(obj.flatShading),
    depthWrite: obj.depthWrite !== false,
    depthTest: obj.depthTest !== false,
    alphaTest: num(obj.alphaTest, 0, 0, 1, warnings, `${path}.alphaTest`),
    vertexColors: Boolean(obj.vertexColors)
  };
}

function normalizeGeometry(raw, primitive, warnings, path) {
  const allowed = {
    box: ["width", "height", "depth", "segments"],
    sphere: ["radius", "widthSegments", "heightSegments", "phiStart", "phiLength", "thetaStart", "thetaLength"],
    cylinder: ["radiusTop", "radiusBottom", "height", "radialSegments", "openEnded", "thetaStart", "thetaLength"],
    cone: ["radius", "height", "radialSegments", "openEnded", "thetaStart", "thetaLength"],
    torus: ["radius", "tube", "radialSegments", "tubularSegments", "arc"],
    plane: ["width", "height", "widthSegments", "heightSegments"],
    capsule: ["radius", "length", "capSegments", "radialSegments"]
  }[primitive] || [];
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
  if (originalPrimitive === "pyramid") {
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
  if (!BASE_PRIMITIVES.has(primitive)) {
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
  const expandedObjects = expandAssemblies(rawObjects.slice(0, MAX_OBJECTS), warnings);
  const objects = expandedObjects.slice(0, MAX_EXPANDED_OBJECTS).filter(isObject).map((o, i) => normalizeObject(o, i, ids, materialIds, warnings));
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
    primitives: [...BASE_PRIMITIVES].sort(),
    aliases: { ...PRIMITIVE_ALIASES },
    assemblies: [...ASSEMBLY_NAMES].sort(),
    maxInputCharacters: MAX_INPUT_CHARS,
    maxInputObjects: MAX_OBJECTS,
    maxExpandedObjects: MAX_EXPANDED_OBJECTS,
    security: { executesGeneratedCode: false, acceptsDeclarativeSceneData: true }
  };
}
