/**
 * gate.ts — the ffmpeg image gate (replaces pi's Photon pipeline).
 *
 * Every raster extendedRead emits passes through this gate before
 * serialization:
 *  - **Direct** images (native formats) pass through byte-identical when
 *    within limits; over-limit direct images are re-encoded in their own
 *    format (never cross-converted).
 *  - **Derived** rasters (converted formats, video frames, PDF renders,
 *    trace crops) are encoded to JPEG.
 *
 * Gate = autorotate → downscale to `maxDim` → encode with a quality ladder
 * until within the base64 budget.
 */

import { readFile, unlink } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ffmpegPath, imageDims, runFfmpeg } from "./ffmpeg.js";
import type { GateOptions } from "./config.js";

export interface GatedImage {
	data: string;
	mimeType: string;
	/** Model-facing notes about what the gate did. */
	notes: string[];
}

const execFileP = promisify(execFileCb);

/**
 * Whether the bundled ffmpeg build has the `autorotate` filter (probed once;
 * not every build ships it). EXIF orientation is applied only when available.
 */
let autorotateAvailable: boolean | null = null;
export async function hasAutorotate(): Promise<boolean> {
	if (autorotateAvailable === null) {
		try {
			const { stdout } = await execFileP(ffmpegPath, ["-filters"], { timeout: 15_000 });
			autorotateAvailable = /\sautorotate\s/.test(stdout);
		} catch {
			autorotateAvailable = false;
		}
	}
	return autorotateAvailable;
}

/** base64 length for a raw byte count. */
export function base64Length(n: number): number {
	return Math.ceil(n / 3) * 4;
}

/**
 * Map a libjpeg quality (1-100) to the mjpeg encoder's qscale (2-31, lower is
 * better). Uses ffmpeg's ff_mjpeg_qscale2quality table directly.
 */
const QSCALE_TABLE = [100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35, 30, 25, 20, 15, 10, 5, 4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1]; // index 0 = qscale 2

export function qualityToQscale(quality: number): number {
	const q = Math.min(100, Math.max(1, quality));
	let best = 2, bestDiff = Infinity;
	for (let qs = 2; qs <= 31; qs++) {
		const diff = Math.abs(QSCALE_TABLE[qs - 2] - q);
		if (diff < bestDiff) {
			bestDiff = diff;
			best = qs;
		}
	}
	return best;
}

/** Direct-format → crop/re-encode extension (animated gif flattens to first frame). */
const MIME_TO_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/bmp": "bmp",
	"image/gif": "png",
};

/**
 * Gate an image file on disk.
 *
 * @param target "same" — direct format: pass through when within limits,
 *   otherwise re-encode in the same format.
 *              "jpeg" — derived raster: pass through when already JPEG and
 *   within limits, otherwise encode to JPEG.
 * @returns the gated image, or null when the gate cannot process the file
 *   (caller falls back to raw bytes).
 */
export async function gateImageFile(
	inputPath: string,
	inputMime: string,
	target: "same" | "jpeg",
	opts: GateOptions,
	timeoutMs: number,
): Promise<GatedImage | null> {
	const bin = ffmpegPath;

	let bytes: Buffer;
	try {
		bytes = await readFile(inputPath);
	} catch {
		return null;
	}

	const notes: string[] = [];
	const dims = await imageDims(inputPath, timeoutMs);
	const within =
		dims !== null &&
		dims.width <= opts.maxDim &&
		dims.height <= opts.maxDim &&
		base64Length(bytes.length) <= opts.maxBytes;

	// Pass-through: within limits and already in the target format.
	if (within && (target === "same" || inputMime === "image/jpeg")) {
		return { data: bytes.toString("base64"), mimeType: inputMime, notes };
	}

	// Re-encode: autorotate + downscale + encode with a quality ladder.
	const targetExt = target === "jpeg" ? "jpg" : (MIME_TO_EXT[inputMime] ?? "jpg");
	const mimeOut = targetExt === "jpg" ? "image/jpeg" : `image/${targetExt}`;
	const qualities =
		targetExt === "jpg" || targetExt === "webp"
			? [opts.jpegQuality, opts.jpegQuality - 5, opts.jpegQuality - 10, opts.jpegQuality - 15]
			: [0]; // lossless: single encode
	const out = join(tmpdir(), `extread-gate-${process.pid}-${randomUUID()}.${targetExt}`);
	try {
		for (let i = 0; i < qualities.length; i++) {
			const q = qualities[i];
			try {
				await encode(bin, inputPath, targetExt, dims, opts, q, out, timeoutMs);
			} catch {
				return null;
			}
			const encoded = await readFile(out).catch(() => null);
			if (encoded && (base64Length(encoded.length) <= opts.maxBytes || i === qualities.length - 1)) {
				notes.push(...gateNotes(inputMime, targetExt, dims, opts, q));
				if (base64Length(encoded.length) > opts.maxBytes)
					notes.push(`still over the ${Math.round(opts.maxBytes / 1048576)}MB budget after quality ${q}`);
				return { data: encoded.toString("base64"), mimeType: mimeOut, notes };
			}
		}
	} finally {
		await unlink(out).catch(() => {});
	}
	return null;
}

/** Model-facing notes for a re-encode. */
function gateNotes(inputMime: string, targetExt: string, dims: { width: number; height: number } | null, opts: GateOptions, q: number): string[] {
	const notes: string[] = [];
	if (inputMime === "image/gif" && targetExt === "png") notes.push("animated GIF flattened to first frame");
	if (dims && (dims.width > opts.maxDim || dims.height > opts.maxDim))
		notes.push(`resized from ${dims.width}x${dims.height} to fit ${opts.maxDim}px`);
	if (q > 0) notes.push(`re-encoded at quality ${q}`);
	return notes;
}

/**
 * One ffmpeg encode: autorotate + downscale + (for JPEG targets) flatten
 * alpha onto white, then encode at the given quality.
 */
async function encode(
	bin: string,
	inputPath: string,
	targetExt: string,
	dims: { width: number; height: number } | null,
	opts: GateOptions,
	quality: number,
	out: string,
	timeoutMs: number,
): Promise<void> {
	const scale = `scale=${opts.maxDim}:${opts.maxDim}:force_original_aspect_ratio=decrease`;
	const rotate = (await hasAutorotate()) ? "autorotate," : "";
	const args: string[] = ["-y", "-v", "error", "-i", inputPath];
	if (targetExt === "jpg") {
		// Flatten alpha onto white (derived rasters may carry alpha).
		// Needs the post-scale size for the background source; without dims
		// fall back to a plain encode (alpha → black, acceptable).
		if (dims) {
			const f = Math.min(1, opts.maxDim / Math.max(dims.width, dims.height));
			const W = Math.max(2, Math.round(dims.width * f));
			const H = Math.max(2, Math.round(dims.height * f));
			args.push(
				"-filter_complex",
				`[0:v]${rotate}${scale},format=rgba[fg];color=white:s=${W}x${H}[bg];[bg][fg]overlay=format=auto,scale=${W}:${H},format=yuv420p[out]`,
				"-map",
				"[out]",
			);
		} else {
			args.push("-vf", `${rotate}${scale}`);
		}
	} else {
		args.push("-vf", `${rotate}${scale}`);
	}
	if (targetExt === "jpg") args.push("-q:v", String(qualityToQscale(quality)));
	else if (targetExt === "webp") args.push("-q:v", String(quality));
	// Single-frame output: the image2 muxer needs it for multi-frame inputs
	// (animated GIF, multi-frame TIFF) — takes the first frame.
	args.push("-frames:v", "1");
	args.push(out);
	await runFfmpeg(bin, args, timeoutMs);
}
