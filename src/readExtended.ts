/**
 * readExtended.ts — extendedRead tool implementation.
 *
 * Model-invoked tool that reads media files (images, audio, video, PDF, PPTX)
 * and returns them as content blocks in the tool result. Mirrors the native
 * `read` tool's flow: resolve → stat → size cap → capability gate → dispatch.
 *
 * Dispatch delegates to specialized modules:
 *   - ffmpeg.ts  — format conversion, region cropping, dimension probing
 *   - image.ts   — pi's Photon resize pipeline
 *   - pdf.ts     — mupdf text/image extraction
 *   - pptx.ts    — PPTX → PDF conversion
 */

import { stat, readFile, unlink } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { homedir } from "node:os";

import type { PluginConfig } from "./config.js";
import { resolveModelConfig } from "./config.js";
import { ffmpegConvert, probeMedia, renderProbeText } from "./ffmpeg.js";
import { processImageBytes } from "./image.js";
import { cropRegionToPng, ZOOM_UNAVAILABLE_HINT } from "./ffmpeg.js";
import { readPdf } from "./pdf.js";
import { readPptx } from "./pptx.js";

// --- Format maps ---

const IMAGE_DIRECT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
};

const IMAGE_CONVERT: Record<string, string> = {
	heic: "png",
	heif: "png",
	tiff: "png",
	tif: "png",
	tga: "png",
	avif: "png",
};

const AUDIO_DIRECT: Record<string, string> = {
	wav: "audio/wav",
	mp3: "audio/mpeg",
	flac: "audio/flac",
	ogg: "audio/ogg",
	aiff: "audio/aiff",
	aif: "audio/aiff",
};

const AUDIO_CONVERT: Record<string, string> = {
	m4a: "mp3",
	aac: "mp3",
	wma: "mp3",
	opus: "mp3",
};

const VIDEO_DIRECT: Record<string, string> = {
	mp4: "video/mp4",
};

const VIDEO_CONVERT: Record<string, string> = {
	webm: "mp4",
	mkv: "mp4",
	mov: "mp4",
	avi: "mp4",
};

// --- Helpers ---

function expandTilde(path: string): string {
	return path.startsWith("~") ? path.replace(/^~/, homedir()) : path;
}

function modalityOf(ext: string): "image" | "audio" | "video" | undefined {
	if (ext in IMAGE_DIRECT || ext in IMAGE_CONVERT) return "image";
	if (ext in AUDIO_DIRECT || ext in AUDIO_CONVERT) return "audio";
	if (ext in VIDEO_DIRECT || ext in VIDEO_CONVERT) return "video";
	return undefined;
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
	/** Crop + scale a rectangular region on any image — direct formats (png,jpg,gif,webp,bmp), converted formats (heic,tiff,tif,avif,...) and PDF image mode. Normalized [x,y,w,h] fractions 0–1 of the bounding box; omit for full frame. */
	zoom?: { x: number; y: number; w: number; h: number };
	/** Metadata-only first look (size, duration, dimensions, audio streams) on ffmpeg-decodable media — no media loaded. */
	info?: boolean;
}

export interface ExtendedReadContext {
	cwd: string;
	modelId: string;
}

export interface AgentToolResult {
	content: { type: string; text?: string; data?: string; mimeType?: string }[];
	details?: unknown;
	isError?: boolean;
}

// --- Shared image handler ---

/**
 * Process image bytes with optional zoom crop, returning content blocks.
 * Shared by direct and convert image handlers.
 */
async function processImageContent(
	bytes: Buffer,
	mime: string,
	zoom: { x: number; y: number; w: number; h: number } | undefined,
	inputPath: string,
	timeoutMs: number,
): Promise<{ content: { type: string; text?: string; data?: string; mimeType?: string }[] }> {
	const zoomHints: string[] = [];
	let finalBytes = bytes;
	let finalMime = mime;
	if (zoom) {
		const cropped = await cropRegionToPng(inputPath, zoom, timeoutMs);
		if (cropped) {
			finalBytes = cropped;
			finalMime = "image/png";
		} else {
			zoomHints.push(ZOOM_UNAVAILABLE_HINT);
		}
	}
	const { data, mimeType } = await processImageBytes(finalBytes, finalMime);
	return {
		content: [
			{ type: "text", text: `Read image [${mimeType}]` },
			...zoomHints.map((h) => ({ type: "text" as const, text: h })),
			{ type: "image", data, mimeType },
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

	// 3. Info probe: metadata-only first look for ffmpeg-decodable media.
	// Runs before the size cap and capability gate so a large file can be
	// inspected before deciding how to load it; result is plain text.
	const ext = extname(path).toLowerCase().slice(1);
	if (params.info) {
		const m = modalityOf(ext);
		if (!m)
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

	// 4. Size cap (per-modality)
	const modality = modalityOf(ext);
	const modelCfg = resolveModelConfig(config, ctx.modelId);
	if (modality && size > modelCfg.maxBytes[modality]) {
		return {
			content: [
				{
					type: "text",
					text: `File too large (${size} > ${modelCfg.maxBytes[modality]} bytes for ${modality})`,
				},
			],
		};
	}

	// 5. Capability gate
	const input = modelCfg.input;

	// 5. Dispatch
	// --- Image direct ---
	if (ext in IMAGE_DIRECT) {
		if (!input.includes("image"))
			return {
				content: [{ type: "text", text: "Model does not support images" }],
			};
		const bytes: Buffer = await readFile(path);
		return processImageContent(bytes, IMAGE_DIRECT[ext], params.zoom, path, config.defaults.ffmpegTimeoutMs);
	}

	// --- Image convertible ---
	if (ext in IMAGE_CONVERT) {
		if (!input.includes("image"))
			return {
				content: [{ type: "text", text: "Model does not support images" }],
			};
		const tmp = await ffmpegConvert(path, "png", config.defaults.ffmpegTimeoutMs);
		try {
			const bytes: Buffer = await readFile(tmp);
			return processImageContent(bytes, "image/png", params.zoom, tmp, config.defaults.ffmpegTimeoutMs);
		} finally {
			await unlink(tmp).catch(() => {});
		}
	}

	// --- Audio direct ---
	if (ext in AUDIO_DIRECT) {
		if (!input.includes("audio"))
			return {
				content: [{ type: "text", text: "Model does not support audio" }],
			};
		const b64 = (await readFile(path)).toString("base64");
		return {
			content: [
				{ type: "text", text: `Read audio [${AUDIO_DIRECT[ext]}]` },
				{ type: "audio", data: b64, mimeType: AUDIO_DIRECT[ext] },
			],
		};
	}

	// --- Audio convertible ---
	if (ext in AUDIO_CONVERT) {
		if (!input.includes("audio"))
			return {
				content: [{ type: "text", text: "Model does not support audio" }],
			};
		const tmp = await ffmpegConvert(path, "mp3", config.defaults.ffmpegTimeoutMs);
		try {
			const b64 = (await readFile(tmp)).toString("base64");
			return {
				content: [
					{ type: "text", text: "Read audio [audio/mpeg]" },
					{ type: "audio", data: b64, mimeType: "audio/mpeg" },
				],
			};
		} finally {
			await unlink(tmp).catch(() => {});
		}
	}

	// --- Video direct ---
	if (ext in VIDEO_DIRECT) {
		if (!input.includes("video"))
			return {
				content: [{ type: "text", text: "Model does not support video" }],
			};
		const b64 = (await readFile(path)).toString("base64");
		return {
			content: [
				{ type: "text", text: `Read video [${VIDEO_DIRECT[ext]}]` },
				{ type: "video", data: b64, mimeType: VIDEO_DIRECT[ext] },
			],
		};
	}

	// --- Video convertible ---
	if (ext in VIDEO_CONVERT) {
		if (!input.includes("video"))
			return {
				content: [{ type: "text", text: "Model does not support video" }],
			};
		const tmp = await ffmpegConvert(path, "mp4", config.defaults.ffmpegTimeoutMs);
		try {
			const b64 = (await readFile(tmp)).toString("base64");
			return {
				content: [
					{ type: "text", text: "Read video [video/mp4]" },
					{ type: "video", data: b64, mimeType: "video/mp4" },
				],
			};
		} finally {
			await unlink(tmp).catch(() => {});
		}
	}

	// --- PDF ---
	if (ext === "pdf") {
		return readPdf(path, params, config, input);
	}

	// --- PPTX (convert to PDF via @s8fy/pptx-converter) ---
	if (ext === "pptx") {
		return readPptx(path, params, config, input);
	}

	// --- Unsupported ---
	return {
		content: [{ type: "text", text: `[extendedRead: unsupported format ${ext}]` }],
	};
}
