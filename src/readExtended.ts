/**
 * readExtended.ts — extendedRead tool implementation.
 *
 * Model-invoked tool that reads media files (images, video, PDF, PPTX) and
 * returns them as content blocks in the tool result. Mirrors the native
 * `read` tool's flow: resolve → stat → size cap → capability gate → dispatch.
 *
 * Dispatch delegates to specialized modules:
 *   - ffmpeg.ts — format conversion, region cropping, dimension probing
 *   - gate.ts   — the ffmpeg image gate (replaces pi's Photon pipeline)
 *   - video.ts  — video → evenly spaced JPEG frames
 *   - pdf.ts    — mupdf text/image extraction
 *   - pptx.ts   — PPTX → PDF conversion
 */

import { stat, readFile, unlink } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { homedir } from "node:os";

import type { PluginConfig } from "./config.js";
import { resolveModelConfig, resolveGateOptions } from "./config.js";
import { probeMedia, renderProbeText, cropRegion, ZOOM_UNAVAILABLE_HINT } from "./ffmpeg.js";
import { gateImageFile, type GatedImage } from "./gate.js";
import { readVideoFrames } from "./video.js";
import { readPdf } from "./pdf.js";
import { readPptx } from "./pptx.js";

// --- Types ---

export interface AgentToolResult {
	content: (
		| { type: "text"; text: string }
		| { type: "image"; data: string; mimeType: string }
	)[];
	details?: unknown;
	isError?: boolean;
}

// --- Format maps ---

const IMAGE_DIRECT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
};

/** Source MIME for converted (non-native) image formats. */
const IMAGE_CONVERT: Record<string, string> = {
	heic: "image/heic",
	heif: "image/heif",
	tiff: "image/tiff",
	tif: "image/tiff",
	tga: "image/tga",
	avif: "image/avif",
};

const VIDEO_EXTS = new Set(["mp4", "webm", "mkv", "mov", "avi"]);
const AUDIO_EXTS = new Set(["wav", "mp3", "flac", "ogg", "aiff", "aif", "m4a", "aac", "wma", "opus"]);

// --- Helpers ---

function expandTilde(path: string): string {
	return path.startsWith("~") ? path.replace(/^~/, homedir()) : path;
}

function modalityOf(ext: string): "image" | "audio" | "video" | null {
	if (ext in IMAGE_DIRECT || ext in IMAGE_CONVERT) return "image";
	if (VIDEO_EXTS.has(ext)) return "video";
	if (AUDIO_EXTS.has(ext)) return "audio";
	return null;
}

/** Direct-format → crop extension (animated gif flattens to first frame). */
function cropExtFor(mime: string): string {
	switch (mime) {
		case "image/png":
		case "image/gif":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/bmp":
			return "bmp";
		default:
			return "png";
	}
}

function mimeForExt(ext: string): string {
	return ext === "jpg" ? "image/jpeg" : `image/${ext}`;
}

// --- Types ---

export interface ExtendedReadParams {
	path: string;
	pages?: string;
	mode?: "text" | "image";
	/** PDF: return table of contents/outline. */
	toc?: boolean;
	/** PDF: search for text (case-insensitive). Returns matching pages with context. */
	search?: string;
	/** PDF: DPI for image mode (overrides config default). Range: 72–600. */
	dpi?: number;
	/** Crop + scale a rectangular region on any image — direct or converted formats and PDF image mode. Normalized [x,y,w,h] fractions 0–1 of the bounding box; omit for full frame. */
	zoom?: { x: number; y: number; w: number; h: number };
	/** Number of frames to extract from a video (1-16). Omit for auto (~1 per 5s of duration). */
	frames?: number;
	/** Metadata-only first look (size, duration, dimensions, audio streams) on ffmpeg-decodable media — no media loaded. */
	info?: boolean;
}

export interface ExtendedReadContext {
	cwd: string;
	modelId: string;
}

// --- Shared image handler ---

/**
 * Gate an image file (with optional zoom crop first), returning content
 * blocks. Shared by direct and converted image handlers.
 *
 * @param target "same" for direct formats (pass through / re-encode in own
 *   format), "jpeg" for derived rasters (converted formats).
 */
async function processImageContent(
	path: string,
	sourceMime: string,
	target: "same" | "jpeg",
	zoom: { x: number; y: number; w: number; h: number } | undefined,
	config: PluginConfig,
): Promise<{ content: AgentToolResult["content"] }> {
	const timeoutMs = config.defaults.ffmpegTimeoutMs;
	const gateOpts = resolveGateOptions(config);
	const notes: string[] = [];
	let image: GatedImage | null = null;

	if (zoom) {
		const targetExt = target === "same" ? cropExtFor(sourceMime) : "jpg";
		const cropped = await cropRegion(path, zoom, targetExt, timeoutMs);
		if (cropped) {
			image = await gateImageFile(cropped, mimeForExt(targetExt), target, gateOpts, timeoutMs);
			await unlink(cropped).catch(() => {});
		} else {
			notes.push(ZOOM_UNAVAILABLE_HINT);
		}
	}
	if (!image) image = await gateImageFile(path, sourceMime, target, gateOpts, timeoutMs);
	if (!image) {
		// Gate unavailable (no ffmpeg / probe failed): raw bytes, no resize.
		const bytes = await readFile(path);
		image = { data: bytes.toString("base64"), mimeType: sourceMime, notes: ["image gate unavailable — raw bytes"] };
	}
	return {
		content: [
			{ type: "text", text: `Read image [${sourceMime}]` },
			...notes.map((h) => ({ type: "text" as const, text: h })),
			...image.notes.map((n) => ({ type: "text" as const, text: n })),
			{ type: "image", data: image.data, mimeType: image.mimeType },
		],
	};
}

// --- Main dispatch ---

export async function readExtended(
	params: ExtendedReadParams,
	ctx: ExtendedReadContext,
	config: PluginConfig,
): Promise<AgentToolResult> {
	// 1. Resolve
	const path = resolve(ctx.cwd, expandTilde(params.path));

	// 2. Stat
	let size: number;
	try {
		const s = await stat(path);
		if (!s.isFile())
			return {
				content: [{ type: "text", text: `Not a file: ${path}` }],
				isError: true,
			};
		size = s.size;
	} catch {
		return {
			content: [{ type: "text", text: `File not found: ${path}` }],
			isError: true,
		};
	}

	const ext = extname(path).toLowerCase().slice(1);
	const modality = modalityOf(ext);
	const modelCfg = resolveModelConfig(config, ctx.modelId);
	const input = modelCfg.input;

	// 3. Info probe: metadata-only first look for ffmpeg-decodable media.
	// Runs before the size cap and capability gate so a large file can be
	// inspected before deciding how to load it; result is plain text.
	if (params.info) {
		if (!modality)
			return {
				content: [
					{
						type: "text",
						text: `Probe [${ext}] ${size} bytes — info works on ffmpeg-decodable media (image/audio/video); for PDF use toc=true/pages, for PPTX pass the file directly`,
					},
				],
			};
		const info = await probeMedia(path, config.defaults.ffmpegTimeoutMs);
		return { content: renderProbeText(info, size, ext).map((t) => ({ type: "text", text: t })) };
	}

	// 4. Audio: support removed — probe-only (info=true) remains.
	if (modality === "audio") {
		return {
			content: [
				{
					type: "text",
					text: `Audio [${ext}] ${size} bytes — audio support removed; probe with info=true for metadata`,
				},
			],
		};
	}

	// 5. Video: read as evenly spaced JPEG frames (bypasses the size cap).
	if (modality === "video") {
		if (!input.includes("image"))
			return {
				content: [{ type: "text", text: "Model does not support images (required for video frames)" }],
			};
		const result = await readVideoFrames(path, ext, size, params.frames, resolveGateOptions(config), config.defaults.ffmpegTimeoutMs);
		if (!result)
			return {
				content: [{ type: "text", text: `Video [${ext}] ${size} bytes — frame extraction failed (ffmpeg)` }],
			};
		const blocks: AgentToolResult["content"] = [...result.notes.map((n) => ({ type: "text" as const, text: n })), { type: "text", text: result.legend }];
		for (const f of result.frames) {
			blocks.push({ type: "text", text: f.caption });
			blocks.push({ type: "image", data: f.data, mimeType: f.mimeType });
		}
		return { content: blocks };
	}

	// 6. Size cap (images only — video bypasses, audio is probe-only).
	if (modality === "image" && size > modelCfg.maxBytes.image) {
		return {
			content: [{ type: "text", text: `File too large (${size} > ${modelCfg.maxBytes.image} bytes for image)` }],
		};
	}

	// 7. Capability gate (images).
	if (!input.includes("image")) {
		return {
			content: [{ type: "text", text: "Model does not support images" }],
		};
	}

	// 8. Image direct: native format — pass through within limits,
	// re-encode in own format over limits.
	if (ext in IMAGE_DIRECT) {
		return processImageContent(path, IMAGE_DIRECT[ext], "same", params.zoom, config);
	}

	// 9. Image converted: non-native format — gate to JPEG.
	if (ext in IMAGE_CONVERT) {
		return processImageContent(path, IMAGE_CONVERT[ext], "jpeg", params.zoom, config);
	}

	// 10. PDF
	if (ext === "pdf") return readPdf(path, params, config, input);

	// 11. PPTX (convert to PDF via @s8fy/pptx-converter)
	if (ext === "pptx") return readPptx(path, params, config, input);

	// 12. Unsupported
	return {
		content: [{ type: "text", text: `[extendedRead: unsupported format ${ext}]` }],
	};
}
