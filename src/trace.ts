// trace.ts — region-finding v2: a numbered overlay for reading coordinates, and a
// crop-from-the-untraced-original.
//
// Both modes operate on `path` at full resolution (never a gated/compressed
// version), so coordinates refer to the true image.
//
//   trace (no coords): overlay numbered guiding lines, write a temp PNG, return
//     the pane(s) + temp path(s). Over-limit images are split into two halves
//     with continuous numbering so the numbers stay legible after the gate.
//   crop  (with coords): crop the untraced original at 0-100 coords, write a temp
//     PNG, return the region readout + temp path.
//
// Temp files live in a per-session dir: <tmp>/extendedread-tmp/<sessionId>/
// media-<n>.png. The /extended-read-clean command deletes folders whose session
// no longer exists.

import { readdir, mkdir, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { imageDims, runFfmpeg, ffmpegPath } from "./ffmpeg.js";

/** A pane of a (possibly split) traced image. */
export interface TracePane {
  tempPath: string;
  /** x-range of this pane in 0-100 percent (continuous across panes). */
  xRange: [number, number];
  /** y-range of this pane in 0-100 percent. */
  yRange: [number, number];
  width: number;
  height: number;
}

export interface TraceResult {
  panes: TracePane[];
  divisions: number;
  sourceWidth: number;
  sourceHeight: number;
  /** True when no font was available (lines only, no numbers). */
  noFont: boolean;
}

export interface CropCoords {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropResult {
  tempPath: string;
  /** The actual (clamped) region in 0-100 percent. */
  region: { x: number; y: number; w: number; h: number };
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * Hint shown when a trace/crop cannot be produced (no dims / ffmpeg failed).
 * Single source of truth for the wording (imported, never re-inlined).
 */
export const TRACE_UNAVAILABLE_HINT =
  "trace/crop unavailable — could not resolve image dimensions (ffmpeg).";

/**
 * Hint when the overlay was drawn without a font (lines only, no numbers).
 */
export const TRACE_NO_FONT_HINT =
  "no font found — overlay has guiding lines only (no numbers); read the 10% grid positions.";

// --- font discovery ----------------------------------------------------------

const FONT_CANDIDATES = [
  "/System/Library/Fonts/SFNSMono.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSansMono-Regular.ttf",
  "/usr/share/fonts/truetype/freefont/FreeMono.ttf",
  "C:/Windows/Fonts/consola.ttf",
  "C:/Windows/Fonts/arial.ttf",
];

/** Locate a TTF/TTF-collection font ffmpeg can draw with, or null. */
export function fontPath(): string | null {
  for (const p of FONT_CANDIDATES) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // ignore, try the next candidate
    }
  }
  return null;
}

/** Escape a font path for use inside a drawtext option value. */
export function escapeDrawtext(p: string): string {
  return p.replace(/([\\,:[])/g, (m) => "\\" + m);
}

// --- temp lifecycle ----------------------------------------------------------

/** Root temp dir for all extendedRead media: <tmp>/extendedread-tmp. */
export function tempRoot(): string {
  return join(tmpdir(), "extendedread-tmp");
}

/** Per-session temp dir, created if missing: <tmp>/extendedread-tmp/<sessionId>. */
export async function sessionTempDir(sessionId: string): Promise<string> {
  const dir = join(tempRoot(), sessionId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * The next free temp path in a session dir: media-<n>.png where n is one past
 * the highest existing media-<n>.png.
 */
export async function nextTempPath(dir: string): Promise<string> {
  let n = 0;
  try {
    const entries = await readdir(dir);
    for (const e of entries) {
      const m = e.match(/^media-(\d+)\.png$/);
      if (m) n = Math.max(n, parseInt(m[1], 10));
    }
  } catch {
    // dir empty or missing — start at 1
  }
  return join(dir, `media-${n + 1}.png`);
}

/**
 * Delete session folders in the temp root whose session id is not in
 * `activeSessionIds`. Returns counts.
 */
export async function cleanTempDirs(
  activeSessionIds: Set<string>,
): Promise<{ deleted: number; kept: number }> {
  const root = tempRoot();
  let deleted = 0;
  let kept = 0;
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return { deleted, kept };
  }
  for (const e of entries) {
    const p = join(root, e);
    try {
      const s = await stat(p);
      if (!s.isDirectory()) continue;
      if (activeSessionIds.has(e)) {
        kept++;
      } else {
        await rm(p, { recursive: true, force: true });
        deleted++;
      }
    } catch {
      // not a dir / gone — skip
    }
  }
  return { deleted, kept };
}

/**
 * Delete the current session's temp dir and return the count of media files
 * removed, or "no-session" when the session has no temp dir.
 */
export async function cleanSession(sessionId: string): Promise<number | "no-session"> {
  const dir = join(tempRoot(), sessionId);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return "no-session";
  }
  const count = entries.filter((e) => e.startsWith("media-")).length;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  return count;
}

// --- overlay geometry --------------------------------------------------------

/** Divisions of 100 that give clean integer labels: 0,25,50,75,100 / 0,20,...,100 / ... */
const VALID_DIVISIONS = [4, 5, 10, 20, 25];

/** Snap an arbitrary division count to the nearest value that divides 100 evenly. */
export function snapDivisions(n: number): number {
  let best = VALID_DIVISIONS[0];
  let bestDiff = Infinity;
  for (const v of VALID_DIVISIONS) {
    const d = Math.abs(v - n);
    if (d < bestDiff) {
      bestDiff = d;
      best = v;
    }
  }
  return best;
}

/**
 * Auto divisions from the longest side: ~1 line per 200px, snapped to a divisor
 * of 100 so labels are exact integers.
 */
export function autoDivisions(longestSide: number): number {
  return snapDivisions(Math.round(longestSide / 200));
}

/** Font pixel size from the longest side: legible after the gate, not dominating. */
export function fontPxFor(longestSide: number): number {
  return Math.max(14, Math.round(longestSide / 60));
}

/** Which split to apply for an over-limit image, given the gate's maxDim. */
export function splitPlan(
  dims: { width: number; height: number },
  maxDim: number,
): "none" | "left-right" | "top-bottom" {
  if (dims.width > maxDim && dims.width >= dims.height) return "left-right";
  if (dims.height > maxDim && dims.height >= dims.width) return "top-bottom";
  return "none";
}

/**
 * Build the ffmpeg filter that overlays numbered guiding lines on an image of
 * WxH. Lines span the full image at 100/divisions % steps; the integer percent
 * is labeled at each line's top (x) and left (y) position.
 */
export function buildOverlayFilter(
  W: number,
  H: number,
  divisions: number,
  font: string | null,
  fontPx: number,
): string {
  const step = 100 / divisions;
  const esc = font ? escapeDrawtext(font) : "";
  const parts: string[] = [];
  for (let i = 0; i <= divisions; i++) {
    const pct = Math.round(i * step);
    const px = Math.round((i * step / 100) * W);
    const py = Math.round((i * step / 100) * H);
    parts.push(`drawbox=x=${px}:y=0:w=2:h=${H}:color=white:t=fill`);
    parts.push(`drawbox=x=0:y=${py}:w=${W}:h=2:color=white:t=fill`);
    if (font) {
      parts.push(
        `drawtext=fontfile=${esc}:text='${pct}':x=${px}:y=2:fontsize=${fontPx}:fontcolor=white:borderw=2:bordercolor=black`,
      );
      parts.push(
        `drawtext=fontfile=${esc}:text='${pct}':x=2:y=${py}:fontsize=${fontPx}:fontcolor=white:borderw=2:bordercolor=black`,
      );
    }
  }
  return parts.join(",");
}

// --- trace (overlay) ---------------------------------------------------------

export interface TraceOptions {
  divisions?: number;
  timeoutMs: number;
  maxDim: number;
}

/**
 * Overlay numbered guiding lines on `source`, write a temp PNG (split into two
 * halves with continuous numbering when over `maxDim`), and return the pane(s).
 * Returns null when the source dims can't be resolved or ffmpeg fails.
 */
export async function traceOverlay(
  source: string,
  sessionId: string,
  opts: TraceOptions,
): Promise<TraceResult | null> {
  const dims = await imageDims(source, opts.timeoutMs);
  if (!dims) return null;
  const font = fontPath();
  const divisions = opts.divisions
    ? snapDivisions(opts.divisions)
    : autoDivisions(Math.max(dims.width, dims.height));
  const fontPx = fontPxFor(Math.max(dims.width, dims.height));
  const filter = buildOverlayFilter(dims.width, dims.height, divisions, font, fontPx);

  const dir = await sessionTempDir(sessionId);
  const fullTemp = await nextTempPath(dir);
  try {
    await runFfmpeg(
      ffmpegPath,
      ["-y", "-v", "error", "-i", source, "-vf", filter, "-frames:v", "1", fullTemp],
      opts.timeoutMs,
    );
  } catch {
    return null;
  }

  const plan = splitPlan(dims, opts.maxDim);
  if (plan === "none") {
    return {
      panes: [
        {
          tempPath: fullTemp,
          xRange: [0, 100],
          yRange: [0, 100],
          width: dims.width,
          height: dims.height,
        },
      ],
      divisions,
      sourceWidth: dims.width,
      sourceHeight: dims.height,
      noFont: font === null,
    };
  }

  // Over-limit: crop two halves from the full traced temp (continuous numbering).
  const halfW = Math.floor(dims.width / 2);
  const halfH = Math.floor(dims.height / 2);
  const [cropA, cropB] =
    plan === "left-right"
      ? [
          ["crop", `${halfW}:${dims.height}:0:0`],
          ["crop", `${halfW}:${dims.height}:${halfW}:0`],
        ]
      : [
          ["crop", `${dims.width}:${halfH}:0:0`],
          ["crop", `${dims.width}:${halfH}:0:${halfH}`],
        ];
  const tempA = await nextTempPath(dir);
  const tempB = await nextTempPath(dir);
  let okA = true;
  let okB = true;
  try {
    await runFfmpeg(
      ffmpegPath,
      ["-y", "-v", "error", "-i", fullTemp, "-vf", cropA[1], "-frames:v", "1", tempA],
      opts.timeoutMs,
    );
  } catch {
    okA = false;
  }
  try {
    await runFfmpeg(
      ffmpegPath,
      ["-y", "-v", "error", "-i", fullTemp, "-vf", cropB[1], "-frames:v", "1", tempB],
      opts.timeoutMs,
    );
  } catch {
    okB = false;
  }
  // The full traced temp is intermediate — remove it; only the halves are returned.
  try {
    await rm(fullTemp, { force: true });
  } catch {
    // ignore
  }
  if (!okA || !okB) return null;

  const panes: TracePane[] =
    plan === "left-right"
      ? [
          { tempPath: tempA, xRange: [0, 50], yRange: [0, 100], width: halfW, height: dims.height },
          { tempPath: tempB, xRange: [50, 100], yRange: [0, 100], width: halfW, height: dims.height },
        ]
      : [
          { tempPath: tempA, xRange: [0, 100], yRange: [0, 50], width: dims.width, height: halfH },
          { tempPath: tempB, xRange: [0, 100], yRange: [50, 100], width: dims.width, height: halfH },
        ];
  return {
    panes,
    divisions,
    sourceWidth: dims.width,
    sourceHeight: dims.height,
    noFont: font === null,
  };
}

// --- crop --------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Crop `source` at 0-100 coords (continuous), write a temp PNG, and return the
 * region readout + temp path. Returns null on failure.
 */
export async function cropToTemp(
  source: string,
  coords: CropCoords,
  sessionId: string,
  timeoutMs: number,
): Promise<CropResult | null> {
  const dims = await imageDims(source, timeoutMs);
  if (!dims) return null;
  const x0 = clamp(coords.x, 0, 100) / 100;
  const y0 = clamp(coords.y, 0, 100) / 100;
  const x1 = clamp(coords.x + coords.w, 0, 100) / 100;
  const y1 = clamp(coords.y + coords.h, 0, 100) / 100;
  const X = Math.round(x0 * dims.width);
  const Y = Math.round(y0 * dims.height);
  const W = Math.max(2, Math.round((x1 - x0) * dims.width));
  const H = Math.max(2, Math.round((y1 - y0) * dims.height));

  const dir = await sessionTempDir(sessionId);
  const out = await nextTempPath(dir);
  try {
    await runFfmpeg(
      ffmpegPath,
      ["-y", "-v", "error", "-i", source, "-vf", `crop=${W}:${H}:${X}:${Y}`, "-frames:v", "1", out],
      timeoutMs,
    );
  } catch {
    return null;
  }

  return {
    tempPath: out,
    region: {
      x: (X / dims.width) * 100,
      y: (Y / dims.height) * 100,
      w: (W / dims.width) * 100,
      h: (H / dims.height) * 100,
    },
    width: W,
    height: H,
    sourceWidth: dims.width,
    sourceHeight: dims.height,
  };
}

/** Human readout of a crop region: 0-100 coords + pixel dims. */
export function cropReadout(c: CropResult): string {
  const r = c.region;
  const f = (n: number) => n.toFixed(1);
  return `x=${f(r.x)} y=${f(r.y)} w=${f(r.w)} h=${f(r.h)} (${c.width}x${c.height}px of ${c.sourceWidth}x${c.sourceHeight})`;
}
