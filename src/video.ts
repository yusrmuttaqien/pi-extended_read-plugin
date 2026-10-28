/**
 * video.ts — video → evenly spaced JPEG frames.
 *
 * Videos are read as frames (no native video block is emitted). Frame count
 * auto-scales with duration (~1 per 5s, clamped 2-16); the `frames` param
 * overrides (1-16). Audio is omitted (noted in the legend).
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ffmpegPath, probeMedia, parseDurationSec, formatTime, runFfmpeg } from "./ffmpeg.js";
import { gateImageFile } from "./gate.js";
import type { GateOptions } from "./config.js";

export const VIDEO_FRAMES_MAX = 16;

/** Auto frame count: ~1 per 5s of duration, clamped to [2, 16]. */
export function autoFrameCount(durationSec: number): number {
	if (durationSec <= 0) return 1;
	return Math.min(VIDEO_FRAMES_MAX, Math.max(2, Math.round(durationSec / 5)));
}

export interface VideoFrameBlock {
	caption: string;
	data: string;
	mimeType: string;
}

export interface VideoReadResult {
	legend: string;
	frames: VideoFrameBlock[];
	/** Model-facing notes (e.g. frames clamped). */
	notes: string[];
}

/**
 * Extract evenly spaced JPEG frames from a video.
 * Returns null when ffmpeg cannot process the file (caller reports the failure).
 */
export async function readVideoFrames(
	path: string,
	ext: string,
	size: number,
	frames: number | undefined,
	gateOpts: GateOptions,
	timeoutMs: number,
): Promise<VideoReadResult | null> {
	const bin = ffmpegPath;
	const probe = await probeMedia(path, timeoutMs);
	if (!probe) return null;

	const dur = parseDurationSec(probe.duration);
	const notes: string[] = [];
	let N: number;
	if (frames !== undefined) {
		N = Math.min(VIDEO_FRAMES_MAX, Math.max(1, Math.round(frames)));
		if (frames < 1 || frames > VIDEO_FRAMES_MAX)
			notes.push(`frames must be between 1 and ${VIDEO_FRAMES_MAX} — clamped to ${N}`);
	} else {
		N = autoFrameCount(dur);
	}

	const dir = join(tmpdir(), `extread-frames-${process.pid}-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	try {
		const args = ["-y", "-v", "error", "-i", path];
		if (dur > 0) args.push("-vf", `fps=${N}/${dur}`);
		args.push("-frames:v", String(N), "-q:v", "2", join(dir, "frame-%03d.jpg"));
		try {
			await runFfmpeg(bin, args, timeoutMs);
		} catch {
			return null;
		}

		const framesOut: VideoFrameBlock[] = [];
		for (let i = 1; i <= N; i++) {
			const p = join(dir, `frame-${String(i).padStart(3, "0")}.jpg`);
			const gated = await gateImageFile(p, "image/jpeg", "jpeg", gateOpts, timeoutMs);
			if (!gated) continue;
			const t = dur > 0 ? (dur * (i - 0.5)) / N : 0;
			framesOut.push({ caption: `Frame ${i}/${N} @ ${formatTime(t)}`, data: gated.data, mimeType: gated.mimeType });
		}
		if (framesOut.length === 0) return null;

		const codec = probe.videoDetail?.split("(")[0].split(",")[0].trim() || "unknown";
		const fps = probe.videoDetail?.match(/(\d+(?:\.\d+)?)\s*fps/)?.[1];
		const dims = probe.width && probe.height ? `, ${probe.width}x${probe.height}` : "";
		const legend = [
			`Video [${ext}] ${size} bytes — ${framesOut.length} frame${framesOut.length === 1 ? "" : "s"} ${frames !== undefined ? "(requested)" : "(auto: ~1 per 5s)"}`,
			`duration: ${probe.duration ?? "?"}${dims}, ${codec}${fps ? `, ${fps} fps` : ""}`,
			probe.hasAudio ? "audio: present — not included (frames only)" : "audio: none",
		].join("\n");
		return { legend, frames: framesOut, notes };
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}
