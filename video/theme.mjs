#!/usr/bin/env node
// Turn pi's real dark theme (okhsl colors) into CSS custom properties so the
// mockup in the video uses the same palette the user actually sees.
//
//   node video/theme.mjs  ->  video/build/theme.css
//
// okhsl → sRGB: lightness goes through Ottosson's toe curve, hue is the OKLab
// hue angle, and saturation scales the maximum in-gamut chroma for that
// lightness/hue (found by bisection), which matches okhsl's intent closely
// enough for these muted UI colors.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PI = "/Users/baptiste/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent";
const theme = JSON.parse(readFileSync(join(PI, "dist/modes/interactive/theme/dark.json"), "utf8"));

const K1 = 0.206, K2 = 0.03, K3 = (1 + K1) / (1 + K2);
const toInv = (x) => (x * x + K1 * x) / (K3 * (x + K2));

/** OKLab (L, a, b) → linear sRGB. */
function labToLinear(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

function maxChroma(L, a_, b_) {
  let lo = 0, hi = 0.5;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(labToLinear(L, mid * a_, mid * b_))) lo = mid;
    else hi = mid;
  }
  return lo;
}

function hex([h, s, l]) {
  const L = toInv(l);
  const a_ = Math.cos(2 * Math.PI * h), b_ = Math.sin(2 * Math.PI * h);
  const C = maxChroma(L, a_, b_) * s;
  return "#" + labToLinear(L, C * a_, C * b_)
    .map((v) => {
      const g = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, g)) * 255).toString(16).padStart(2, "0");
    })
    .join("");
}

const parse = (v) => {
  const m = /^okhsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/.exec(String(v).trim());
  return m ? [Number(m[1]) / 360, Number(m[2]) / 100, Number(m[3]) / 100] : null;
};
/** Resolve a color entry, following references into `vars` (e.g. colors.accent = "violet"). */
const resolve = (key, depth = 0) => {
  const raw = key in theme.vars ? theme.vars[key] : theme.colors[key];
  if (raw == null || depth > 4) return "#ff00ff";
  const hsl = parse(raw);
  if (hsl) return hex(hsl);
  if (raw in theme.vars || raw in theme.colors) return resolve(raw, depth + 1);
  return raw;
};

const wanted = ["text", "muted", "dim", "violet", "blue", "green", "red", "yellow",
  "border", "borderAccent", "borderMuted", "selectedBg", "userMessageBg",
  "toolPendingBg", "toolSuccessBg", "thinkingText", "mdHeading", "mdCode", "mdListBullet"];

mkdirSync(join(here, "build"), { recursive: true });
const css = [
  "/* generated from pi's dark.json by video/theme.mjs — do not edit */",
  ":root {",
  ...wanted.map((k) => `  --${k}: ${resolve(k)};`),
  "  --bg: #0f0f12;",
  "}",
  "",
].join("\n");
writeFileSync(join(here, "build", "theme.css"), css);
console.log(css);
