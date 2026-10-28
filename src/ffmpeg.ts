/**
 * ffmpeg.ts — low-level ffmpeg operations.
 *
 * Wraps @ffmpeg-installer/ffmpeg for format conversion, region cropping,
 * and dimension probing. All functions are async and return null/throw on
 * failure (caller decides fallback behavior).
 */

import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import ffmpeg from "@ffmpeg-installer/ffmpeg";

/** The bundled ffmpeg binary path. */
export const ffmpegPath: string = ffmpeg.path;

/** Appended as a model-visible text block when zoom is requested but cropping fell back to the full frame. */
export const ZOOM_UNAVAILABLE_HINT = "zoom region unavailable — returning full page";

/**
 * Run ffmpeg with args, rejecting on non-zero exit. Shared by the gate,
 * video frame extraction, and crop paths.
 */
export function runFfmpeg(bin: string, args: string[], timeoutMs: number): Promise<void> {
	return new Promise((resolveP, rejectP) => {
		execFile(
			bin,
			args,
			{ timeout: timeoutMs },
			(err) => {
				if (err) rejectP(err);
				else resolveP();
			},
		);
	});
}

/** Promisified execFile returning both stdout and stderr. */
export function runCmd(
	binary: string,
	args: string[],
	timeoutMs = 10_000,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolveP, rejectP) => {
		execFile(binary, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
			if (err)
				rejectP(err);
			else
				resolveP({ stdout, stderr });
		});
	});
}

export interface ProbeInfo {
	/** Demuxer/format name from the "Input #0, ..." line (e.g. "mov"). */
	format?: string;
	/** Human duration as ffmpeg prints it, e.g. "00:01:30.00". */
	duration?: string;
	bitrate?: string;
	width?: number;
	height?: number;
	videoDetail?: string;
	audioDetail?: string;
	/** true when an Audio stream is present in the probe output. */
	hasAudio: boolean;
}

/**
 * Parse ffmpeg's "ffmpeg -i file" stderr dump into structured metadata:
 * format, duration, video dimensions/codec, audio codec/sample rate.
 * Pure function; returns null when no stream info is present (non-decodable input).
 */
export function parseFfmpegProbe(stderr: string): ProbeInfo | null {
	const s = String(stderr);
	const out: ProbeInfo = { hasAudio: false };
	const fmt = s.match(/Input #\d+, ([^,]+)/);
	if (fmt) out.format = fmt[1].trim();
	const dur = s.match(/Duration:\s*([0-9:.]+)/);
	if (dur) out.duration = dur[1];
	const br = s.match(/bitrate:\s*(\d+ kb\/s)/);
	if (br) out.bitrate = br[1];
	// Video stream line: codec detail + WxH inside the descriptor.
	const vm = s.match(/Stream #\d+:\d+[^\n]*Video:\s*([^\n]+)/);
	if (vm) {
		out.videoDetail = vm[1].trim();
		// Word-anchored WxH scan: ffmpeg prints codec fourcc pointers like
		// "(avc1 / 0x31637661)", whose digit runs match a bare \d+x\d+ with
		// width 0 and a bogus height. Skip them; take the first valid pair.
		for (const d of vm[1].matchAll(/\b(\d{1,4})x(\d{1,4})\b/g)) {
			if (+d[1] > 0 && +d[2] > 0) {
				out.width = +d[1];
				out.height = +d[2];
				break;
		}
	}
}
	const am = s.match(/Stream #\d+:\d+[^\n]*Audio:\s*([^\n]+)/);
	if (am) {
		out.hasAudio = true;
		out.audioDetail = am[1].trim();
	}
	if (!out.format && !out.duration && !out.videoDetail && !out.audioDetail)
		return null;
	return out;
}

/**
 * Probe a media file's metadata (duration, dimensions, streams) without
 * loading any media. ffmpeg prints the stream dump to stderr on "-i".
 * Returns null when ffmpeg cannot decode the input.
 */
export async function probeMedia(inputPath: string, timeoutMs = 10_000): Promise<ProbeInfo | null> {
	try {
		const { stderr } = await runCmd(ffmpegPath, ["-hide_banner", "-i", inputPath, "-f", "null", "-"], timeoutMs);
		return parseFfmpegProbe(stderr);
	} catch {
		/* fall through to null */
	}
	return null;
}

/** Render a ProbeInfo (or null) as model-visible text lines. Pure. */
export function renderProbeText(info: ProbeInfo | null, size: number, ext: string): string[] {
	const head = `Probe [${ext}] ${size} bytes`;
	if (!info)
		return [`Probe [${ext}] ${size} bytes`, "probe unavailable — ffmpeg cannot decode this input"];
	const lines = [head];
	if (info.format) lines.push(`format: ${info.format}`);
	if (info.duration) lines.push(`duration: ${info.duration}${info.bitrate ? `, bitrate: ${info.bitrate}` : ""}`);
	if (info.videoDetail) {
		const dims = info.width && info.height ? ` (${info.width}x${info.height})` : "";
		lines.push(`Video:${dims} ${info.videoDetail}`);
	}
	lines.push(info.hasAudio ? `Audio: present — ${info.audioDetail}` : "audio: none");
	return lines;
}

/**
 * Parse an ffmpeg duration string ("HH:MM:SS.xx" or "MM:SS.xx") into
 * seconds. Returns 0 for missing/unparseable input.
 */
export function parseDurationSec(duration: string | undefined): number {
	if (!duration) return 0;
	const m = duration.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
	if (!m) return 0;
	const h = m[1] ? parseInt(m[1], 10) : 0;
	return h * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
}

/** Format seconds as m:ss or h:mm:ss. */
export function formatTime(sec: number): string {
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = Math.floor(sec % 60);
	return h > 0
		? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
		: `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Extract an image's pixel dimensions via ffmpeg's probe output.
 * Returns null on any failure (caller falls back to no-zoom).
 */
export async function imageDims(inputPath: string, timeoutMs = 10_000): Promise<{ width: number; height: number } | null> {
	try {
		const { stderr } = await runCmd(ffmpegPath, ["-hide_banner", "-i", inputPath, "-vframes", "1", "-f", "null", "-"], timeoutMs);
		return parseFfmpegDims(stderr);
	} catch {
		/* fall through to no-zoom */
	}
	return null;
}

/**
 * Parse "WxH" from ffmpeg's probe stderr. Anchored to the "Video:" stream
 * descriptor line: a bare \d+x\d+ also matches ffmpeg's memory pointer
 * (e.g. "[png_pipe @ 0x137808200]"), which appears first when ffmpeg prints
 * the "not enough frames to estimate rate" warning and would otherwise yield
 * width=0 and a spurious null. Returns null if no valid dimensions are present.
 */
export function parseFfmpegDims(stderr: string): { width: number; height: number } | null {
	const m = String(stderr).match(/Video:.*?(\d+)x(\d+)/);
	if (m && +m[1] > 0 && +m[2] > 0)
		return { width: +m[1], height: +m[2] };
	return null;
}

/**
 * Crop a region of an image raster (any ffmpeg-decodable input) at normalized
 * [x,y,w,h] fractions, writing the crop to a temp file in `targetExt`.
 * Returns the output path (caller must unlink), or null if dimensions can't
 * be resolved or the crop fails.
 */
export async function cropRegion(
	inputPath: string,
	zoom: { x: number; y: number; w: number; h: number },
	targetExt: string,
	timeoutMs: number,
): Promise<string | null> {
	const dims = await imageDims(inputPath, timeoutMs);
	if (!dims) return null;
	return cropRegionWithDims(inputPath, zoom, dims, targetExt, timeoutMs);
}

/**
 * Crop a region given pre-computed pixel dimensions (skips the per-call ffmpeg
 * probe). Returns the output temp path (caller must unlink), or null on failure.
 */
export async function cropRegionWithDims(
	inputPath: string,
	zoom: { x: number; y: number; w: number; h: number },
	dims: { width: number; height: number },
	targetExt: string,
	timeoutMs: number,
): Promise<string | null> {
	// JPEG targets require even dimensions (yuv420p); round down.
	const even = targetExt === "jpg" ? 2 : 1;
	const W = Math.max(even, Math.round(zoom.w * dims.width / even) * even);
	const H = Math.max(even, Math.round(zoom.h * dims.height / even) * even);
	const maxX = Math.max(0, dims.width - W);
	const maxY = Math.max(0, dims.height - H);
	const X = Math.min(Math.floor(zoom.x * dims.width), maxX);
	const Y = Math.min(Math.floor(zoom.y * dims.height), maxY);
	const outPath = join(tmpdir(), `extread-crop-${process.pid}-${randomUUID()}.${targetExt}`);
	try {
		await runCmd(ffmpegPath, ["-y", "-v", "error", "-i", inputPath, "-vf", `crop=${W}:${H}:${X}:${Y}`, outPath], timeoutMs);
		return outPath;
	} catch {
		await unlink(outPath).catch(() => {});
		return null;
	}
}
