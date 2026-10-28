/**
 * index.ts — plugin entry point.
 *
 * Registers the extendedRead tool and applies pi patches on activation.
 * Exposes slash commands:
 *   /extended-read-patch — re-apply pi patches (after pi updates)
 *   /extended-read-config — regenerate config.json (backs up existing as .1, .2, …)

 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, copyFileSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig, executionMode } from "./config.js";
import { readExtended } from "./readExtended.js";
import { applyPatches, resolvePiRoot, piVersion } from "./patch/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(__dirname, ".."); // src/ → plugin root

export default function activate(pi: ExtensionAPI) {
	const config = loadConfig(pluginDir);

	// Apply patches on load (idempotent).
	const piRoot = resolvePiRoot();
	const results = applyPatches(piRoot);
	const version = piVersion(piRoot);
	for (const r of results) {
		if (r.status === "patched") {
			console.log(`[pi-extendedread] patched: ${r.id} (pi v${version})`);
		} else if (r.status === "not-found") {
			console.warn(`[pi-extendedread] WARNING: ${r.message}`);
		}
	}

	// Register the tool.
	pi.registerTool({
		name: "extendedRead",
		label: "Extended Read",
		description:
			"Read a media file and return it as an attachment the model can perceive. " +
			"Images: png, jpg, jpeg, gif, webp, bmp, heic, heif, tiff, tif, tga, avif. " +
			"Audio: wav, mp3, flac, ogg, aiff, aif, m4a, aac, wma, opus. " +
			"Video: mp4, webm, mkv, mov, avi. " +
			"PDF: text extraction (default) or page rendering to image. Use pages='1-5' for pagination, toc=true for outline, search='query' to find text, dpi=N for resolution, zoom='{x,y,w,h}' to crop+scale a rectangular region on any image — direct or converted formats and PDF image mode. " +
			"Probe mode: info=true returns metadata only (size, duration, dimensions, audio streams) for image/audio/video without loading media — a first look on large video/audio; no ad-hoc ffprobe script needed. " +
			"PPTX: converts to PDF via @s8fy/pptx-converter, then uses the PDF pipeline. " +
			"For text files, use the native read tool.",
		promptSnippet: "Read media files",
		promptGuidelines: [
			"Use extendedRead to read media files (images, audio, video, PDF) the user references.",
			"Do not write ad-hoc scripts for actions the tool already provides: probe with info=true instead of parsing ffprobe/ffmpeg output, zoom for image regions, pages/toc/search for PDF navigation.",
			"For large images, drill down with zoom before answering from a downscaled full-frame view.",
			"Never read a long PDF all at once: toc=true when structure is unknown, search='query' to locate mentions, pages='5-10' for targeted pages, mode='image' (+dpi) for charts and scans.",
			"Probe large video/audio with info=true first; drop info=true to load the file itself. Files over maxBytes return a size note — do not retry blindly.",
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
			zoom: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number(), w: Type.Number(), h: Type.Number() }, { description: "Crop + scale a rectangular region on any image — direct formats (png,jpg,gif,webp,bmp), converted formats (heic,tiff,tif,avif,...) and PDF image mode. Normalized [x,y,w,h] fractions 0–1 of the bounding box; omit for full frame." })),
		}),
		executionMode: executionMode(config),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const modelId = ctx.model?.id ?? "unknown";
			// Cast: our result includes audio/video blocks not in pi's type system
			return (await readExtended(
				params,
				{ cwd: ctx.cwd, modelId },
				config,
			)) as any;
		},
	});

	// Register /extended-read-patch slash command.
	pi.registerCommand("extended-read-patch", {
		description: "Re-apply pi patches (after pi updates)",
		handler: async (_args, ctx) => {
			const r = applyPatches(piRoot);
			const lines = r.map((x) => `  ${x.status}: ${x.id} — ${x.message}`);
			ctx.ui.notify(
				`extended-read-patch (pi v${version}):\n${lines.join("\n")}`,
				"info",
		);
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
}
