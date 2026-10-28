/**
 * index.ts — plugin entry point.
 *
 * Registers the extendedRead tool. Exposes slash commands:
 *   /extended-read-config — regenerate config.json (backs up existing as .1, .2, …)
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, copyFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig, executionMode } from "./config.js";
import { readExtended } from "./readExtended.js";
import { cleanSession } from "./trace.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(__dirname, ".."); // src/ → plugin root

export default function activate(pi: ExtensionAPI) {
	const config = loadConfig(pluginDir);

	// Register the tool.
	pi.registerTool({
		name: "extendedRead",
		label: "Extended Read",
		description:
			"Read a media file and return it as an attachment the model can perceive. " +
			"Images: png, jpg, jpeg, gif, webp, bmp, heic, heif, tiff, tif, tga, avif — every image is gated (bounded dims/bytes; derived rasters are JPEG). " +
			"Video: mp4, webm, mkv, mov, avi — read as evenly spaced JPEG frames (audio not included). " +
			"PDF: text extraction (default) or page rendering to image. Use pages='1-5' for pagination, toc=true for outline, search='query' to find text, dpi=N for resolution. " +
			"Region-finding (images + PDF image mode): trace={} overlays numbered guiding lines (0-100 coords) to read coordinates; trace={x,y,w,h} (0-100) crops the original at those coords. " +
			"Probe mode: info=true returns metadata only (size, duration, dimensions, audio streams) for image/audio/video without loading media — a first look on large video/audio; no ad-hoc ffprobe script needed. " +
			"PPTX: converts to PDF via @s8fy/pptx-converter, then uses the PDF pipeline. " +
			"For text files, use the native read tool.",
		promptSnippet: "Read media files",
		promptGuidelines: [
			"Use extendedRead to read media files (images, video, PDF) the user references.",
			"Do not write ad-hoc scripts for actions the tool already provides: probe with info=true instead of parsing ffprobe/ffmpeg output, trace for image regions, pages/toc/search for PDF navigation.",
			"For large images, read coordinates with trace={} then crop with trace={x,y,w,h} before answering from a downscaled full-frame view.",
			"Never read a long PDF all at once: toc=true when structure is unknown, search='query' to locate mentions, pages='5-10' for targeted pages, mode='image' (+dpi) for charts and scans.",
			"Video is read as frames (audio not included); probe large video/audio with info=true first. Files over maxBytes return a size note — do not retry blindly.",
			"Use the native read tool for text files.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file (relative, absolute, or ~)" }),
			pages: Type.Optional(Type.String({ description: "Page selector for PDFs: '1', '1-5', '3,7,12' (default: '1')" })),
			mode: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("image")], { description: "PDF mode: 'text' (default) or 'image'" })),
			toc: Type.Optional(Type.Boolean({ description: "PDF: return table of contents/outline" })),
			search: Type.Optional(Type.String({ description: "PDF: search for text (case-insensitive), returns matching pages with context" })),
			dpi: Type.Optional(Type.Number({ description: "PDF: DPI for image mode (72-600, default from config)" })),
			info: Type.Optional(Type.Boolean({ description: "Metadata-only first look on ffmpeg-decodable media (image/audio/video): size, duration, dimensions, video codec, audio streams. No media loaded; use before deciding how to load a large file. No ad-hoc ffprobe script needed." })),
			trace: Type.Optional(Type.Object({ x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), w: Type.Optional(Type.Number()), h: Type.Optional(Type.Number()), lines: Type.Optional(Type.Number()) }, { description: "Region-finding (images + PDF image mode). No coords → trace mode: numbered overlay (0-100 coords) to read coordinates. With x,y,w,h (0-100) → crop mode: crop the original at those coords. lines=N overrides grid density (default 10)." })),
			frames: Type.Optional(Type.Number({ description: "Number of frames to extract from a video (1-16); omit for auto (~1 per 5s of duration)" })),
		}),
		executionMode: executionMode(config),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const modelId = ctx.model?.id ?? "unknown";
			// Cast: our result omits `details` (required in pi's type).
			return (await readExtended(params, { cwd: ctx.cwd, modelId, sessionId: ctx.sessionManager.getSessionId() }, config)) as any;
		},
	});

	// Register /extended-read-config slash command.
	pi.registerCommand("extended-read-config", {
		description: "Regenerate config.json (backs up existing as .1, .2, …)",
		handler: async (_args, ctx) => {
			const { userConfigPath } = await import("./config.js");
			const configPath = userConfigPath();

			if (existsSync(configPath)) {
				// Find next available backup number
				let n = 1;
				while (existsSync(`${configPath}.${n}`)) n++;
				copyFileSync(configPath, `${configPath}.${n}`);
				ctx.ui.notify(
					`Config backed up to config.json.${n}\nRegenerating…`,
					"info",
				);
			} else {
				ctx.ui.notify("No existing config. Generating…", "info");
			}

			// Copy from plugin default
			copyFileSync(join(pluginDir, "config.json"), configPath);
			ctx.ui.notify(
				`Config regenerated at ${configPath}`,
				"info",
			);
		},
	});

	// Register /extended-read-clean slash command.
	pi.registerCommand("extended-read-clean", {
		description: "Delete this session's trace/crop temp files (extendedread-tmp/<session_id>/)",
		handler: async (_args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			const result = await cleanSession(sessionId);
			if (result === "no-session") {
				ctx.ui.notify("No temp files to clean (no trace/crop this session).", "info");
			} else {
				ctx.ui.notify(`Cleaned ${result} temp file(s) for this session.`, "info");
			}
		},
	});
}
