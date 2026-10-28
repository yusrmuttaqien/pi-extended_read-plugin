/**
 * pptx.ts — PPTX handling via @s8fy/pptx-converter (WASM).
 *
 * Converts PPTX → PDF in-memory, writes to a temp file, then delegates to
 * the PDF pipeline. Temp directory is cleaned up in finally.
 */

import { readFile, writeFile, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PluginConfig } from "./config.js";
import { readPdf } from "./pdf.js";

/**
 * Read a PPTX file: convert to PDF via @s8fy/pptx-converter, then use the
 * PDF pipeline for text extraction or image rendering.
 */
export async function readPptx(
	path: string,
	params: { pages?: string; mode?: "text" | "image"; toc?: boolean; search?: string; dpi?: number; zoom?: { x: number; y: number; w: number; h: number } },
	config: PluginConfig,
	input: string[],
): Promise<import("./readExtended.js").AgentToolResult> {
	const { pptxToPdf } = await import("@s8fy/pptx-converter");
	try {
		const pptxBuffer = await readFile(path);
		const result = await pptxToPdf(pptxBuffer);
		// Write PDF to temp file for readPdf
		const tmpDir = await mkdtemp(join(tmpdir(), "pi-pptx-"));
		const pdfPath = join(tmpDir, "converted.pdf");
		await writeFile(pdfPath, result.data);
		try {
			return await readPdf(pdfPath, params, config, input);
		} finally {
			await rm(tmpDir, { recursive: true }).catch(() => {});
		}
	} catch (e: any) {
		return {
			content: [
				{
					type: "text",
					text: `[extendedRead: PPTX conversion failed: ${e.message}]`,
				},
			],
		};
	}
}
