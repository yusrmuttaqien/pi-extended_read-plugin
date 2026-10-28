/**
 * pdf.ts — PDF handling via mupdf (WASM).
 *
 * Text extraction, page rendering to PNG, TOC/outline, search, and DPI
 * control. Supports zoom (region crop) in image mode.
 */

import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { PluginConfig } from "./config.js";
import type { AgentToolResult } from "./readExtended.js";
import { resolveGateOptions } from "./config.js";
import { cropRegion, ZOOM_UNAVAILABLE_HINT } from "./ffmpeg.js";
import { gateImageFile } from "./gate.js";

/**
 * Read a PDF: text extraction, image rendering, TOC, search.
 * Returns content blocks ready for the tool result.
 */
export async function readPdf(
	path: string,
	params: { pages?: string; mode?: "text" | "image"; toc?: boolean; search?: string; dpi?: number; zoom?: { x: number; y: number; w: number; h: number } },
	config: PluginConfig,
	input: string[],
): Promise<{ content: AgentToolResult["content"]; isError?: boolean }> {
	const mupdf = await import("mupdf") as any;
	const buffer = await readFile(path);
	const doc = mupdf.Document.openDocument(buffer, "application/pdf");
	try {
		const totalPages = doc.countPages();
		const maxPages = config.defaults.pdf?.maxPagesPerCall ?? 10;
		let pageIndices = parsePageSelector(params.pages ?? "1", totalPages);
		if (pageIndices.length > maxPages) {
			pageIndices = pageIndices.slice(0, maxPages);
		}
		const mode = params.mode ?? "text";
		const dpi = params.dpi ?? config.defaults.pdf?.defaultDpi ?? 150;
		const gateOpts = resolveGateOptions(config);

		// --- TOC mode ---
		if (params.toc) {
			return readPdfToc(doc);
		}

		// --- Search mode ---
		if (params.search) {
			return readPdfSearch(doc, params.search, pageIndices, totalPages);
		}

		if (mode === "image" && !input.includes("image")) {
			return {
				content: [{ type: "text", text: "Model does not support images (required for PDF image mode)" }],
			};
		}

		const blocks: AgentToolResult["content"] = [];

		if (mode === "text") {
			// Text extraction
			for (const i of pageIndices) {
				const page = doc.loadPage(i);
				try {
					const stext = page.toStructuredText("preserve-whitespace");
					const text = stext.asText();
					stext.destroy();
					if (text.trim().length === 0) {
						blocks.push({ type: "text", text: `--- Page ${i + 1} ---\n[no text on this page — use mode='image' to view]` });
					} else {
						blocks.push({ type: "text", text: `--- Page ${i + 1} ---\n${text}` });
					}
				} finally {
					page.destroy();
				}
			}
			blocks.push({
				type: "text",
				text: `PDF: ${totalPages} pages. Read pages ${pageIndices.map((i) => i + 1).join(",")}. Use pages='N-M' for more, mode='image' to view visually, toc=true for outline, search='query' to find text.`,
			});
		} else {
			// Image rendering
			for (const i of pageIndices) {
				const page = doc.loadPage(i);
				try {
					const pixmap = page.toPixmap(
						mupdf.Matrix.scale(dpi / 72, dpi / 72),
						mupdf.ColorSpace.DeviceRGB,
					);
					try {
						const png = Buffer.from(pixmap.asPNG());
						blocks.push({
							type: "text",
							text: `PDF page ${i + 1} of ${totalPages} (${dpi} DPI)`,
						});
						const tmpInput = join(tmpdir(), `pi-pdf-${process.pid}-${randomUUID()}.png`);
						await writeFile(tmpInput, png);
						let image = null;
						if (params.zoom) {
							const cropped = await cropRegion(tmpInput, params.zoom, "png", config.defaults.ffmpegTimeoutMs);
							if (cropped) {
								image = await gateImageFile(cropped, "image/png", "jpeg", gateOpts, config.defaults.ffmpegTimeoutMs);
								await unlink(cropped).catch(() => {});
							} else {
								blocks.push({ type: "text", text: ZOOM_UNAVAILABLE_HINT });
							}
						}
						if (!image) image = await gateImageFile(tmpInput, "image/png", "jpeg", gateOpts, config.defaults.ffmpegTimeoutMs);
						await unlink(tmpInput).catch(() => {});
						if (image) {
							blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
						} else {
							// Gate unavailable — raw render, never lose the page.
							blocks.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
						}
					} finally {
						pixmap.destroy();
					}				} finally {
					page.destroy();
				}
			}
			blocks.push({
				type: "text",
				text: `PDF: ${totalPages} pages. Read pages ${pageIndices.map((i) => i + 1).join(",")} at ${dpi} DPI. Use pages='N-M' for more, dpi=N to change resolution.`,
			});
		}

		return { content: blocks };
	} finally {
		doc.destroy();
	}
}

/** Extract and format the PDF outline/TOC. */
function readPdfToc(doc: any): { content: AgentToolResult["content"] } {
	const outline = doc.loadOutline();
	if (!outline || outline.length === 0) {
		return {
			content: [{ type: "text", text: "PDF has no table of contents/outline." }],
		};
	}
	const lines: string[] = ["PDF Outline:"];
	function walk(items: any[], depth: number) {
		for (const item of items) {
			const indent = "\t".repeat(depth);
			const pageRef = item.page != null ? ` [p.${item.page + 1}]` : "";
			lines.push(`${indent}- ${item.title ?? "(untitled)"}${pageRef}`);
			if (item.down && item.down.length > 0) {
				walk(item.down, depth + 1);
			}
		}
	}
	walk(outline, 0);
	lines.push("");
	lines.push("Use pages='N' to read a specific page, search='query' to find text.");
	return { content: [{ type: "text", text: lines.join("\n") }] };
}

/** Search PDF pages for text, return matching pages with context. */
function readPdfSearch(
	doc: any,
	needle: string,
	pageIndices: number[],
	totalPages: number,
): { content: AgentToolResult["content"] } {
	const blocks: AgentToolResult["content"] = [];
	let totalHits = 0;

	for (const i of pageIndices) {
		const page = doc.loadPage(i);
		try {
			const hits = page.search(needle);
			if (hits && hits.length > 0) {
				totalHits += hits.length;
				// Get surrounding context from structured text
				const stext = page.toStructuredText("preserve-whitespace");
				const text = stext.asText();
				stext.destroy();
				// Find the needle in text (case-insensitive) for context
				const lowerText = text.toLowerCase();
				const lowerNeedle = needle.toLowerCase();
				const idx = lowerText.indexOf(lowerNeedle);
				let context: string;
				if (idx >= 0) {
					const start = Math.max(0, idx - 60);
					const end = Math.min(text.length, idx + needle.length + 60);
					context = (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
				} else {
					context = text.slice(0, 120) + (text.length > 120 ? "…" : "");
				}
				blocks.push({
					type: "text",
					text: `--- Page ${i + 1} (${hits.length} hit${hits.length === 1 ? "" : "s"}) ---\n${context}`,
				});
			}
		} finally {
			page.destroy();
		}
	}

	if (totalHits === 0) {
		blocks.push({
			type: "text",
			text: `No matches for "${needle}" in pages ${pageIndices.map((i) => i + 1).join(",")}.`,
		});
	} else {
		blocks.push({
			type: "text",
			text: `Search "${needle}": ${totalHits} hit${totalHits === 1 ? "" : "s"} across ${pageIndices.length} page${pageIndices.length === 1 ? "" : "s"}. Use pages='N' to read full page content.`,
		});
	}

	return { content: blocks };
}

/** Parse a page selector like "1", "1-5", "3,7,12" into zero-based indices. */
export function parsePageSelector(selector: string, totalPages: number): number[] {
	const indices: number[] = [];
	for (const part of selector.split(",")) {
		const trimmed = part.trim();
		if (trimmed.includes("-")) {
			const [start, end] = trimmed.split("-").map((s) => parseInt(s, 10) - 1);
			for (let i = Math.max(0, start); i < Math.min(totalPages - 1, end); i++) {
				indices.push(i);
			}
		} else {
			const i = parseInt(trimmed, 10) - 1;
			if (i >= 0 && i < totalPages) indices.push(i);
		}
	}
	// Deduplicate and sort
	return [...new Set(indices)].sort((a, b) => a - b);
}
