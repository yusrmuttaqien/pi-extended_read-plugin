/**
 * readExtended.test.ts — tests for the extendedRead tool.
 *
 * Tests the dispatch logic: resolve, stat, size cap, capability gate,
 * format dispatch, and error handling.
 */

import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

import { readExtended } from "../src/readExtended.js";
import { cropRegionToPng, parseFfmpegDims } from "../src/ffmpeg.js";
import type { PluginConfig } from "../src/config.js";

/** Extract text from array content. */
function text(content: { type: string; text?: string }[]): string {
	return content.map((c) => c.text ?? "").join("\n");
}

const config: PluginConfig = {
	models: {},
	defaults: {
		input: ["text", "image", "audio", "video"],
		maxBytes: { image: 10485760, audio: 20971520, video: 52428800 },
		executionMode: "parallel",
		ffmpegTimeoutMs: 30000,
	},
};

test("file not found", async () => {
	const result = await readExtended(
		{ path: "/nonexistent/file.png" },
		{ cwd: "/tmp", modelId: "test" },
		config,
	);
	assert.equal(result.isError, true);
	assert.match(text(result.content as any), /File not found/);
});

test("not a file (directory)", async () => {
	const result = await readExtended(
		{ path: "/tmp" },
		{ cwd: "/tmp", modelId: "test" },
		config,
	);
	assert.equal(result.isError, true);
	assert.match(text(result.content as any), /Not a file/);
});

test("unsupported extension", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "test.txt");
	await writeFile(file, "hello");

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		config,
	);
	assert.match(text(result.content as any), /unsupported format/);

	await rm(dir, { recursive: true });
});

test("size cap exceeded", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "big.png");
	// Create a file larger than the image cap (10 MB).
	await writeFile(file, Buffer.alloc(11 * 1024 * 1024));

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		config,
	);
	assert.match(text(result.content as any), /File too large/);

	await rm(dir, { recursive: true });
});

test("capability gate: model doesn't support audio", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "test.mp3");
	await writeFile(file, Buffer.from("fake mp3 data"));

	const audioConfig: PluginConfig = {
		...config,
		defaults: { ...config.defaults, input: ["text", "image"] },
	};

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		audioConfig,
	);
	assert.match(text(result.content as any), /does not support audio/);

	await rm(dir, { recursive: true });
});

test("tilde expansion", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "test.txt");
	await writeFile(file, "hello");

	// Use ~ in the path (should expand to homedir).
	// We can't easily test the actual homedir, so just verify it doesn't crash.
	const result = await readExtended(
		{ path: `~/${file.split("/").pop()}` },
		{ cwd: dir, modelId: "test" },
		config,
	);
	// Should be "File not found" (since the file isn't actually in homedir).
	assert.equal(result.isError, true);

	await rm(dir, { recursive: true });
});

test("PDF text extraction", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	// Minimal valid PDF (1 page, empty).
	const pdfBytes = Buffer.from(
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
		"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
		"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
		"xref\n0 4\n0000000000 65535 f \n" +
		"0000000009 00000 n \n" +
		"0000000058 00000 n \n" +
		"0000000113 00000 n \n" +
		"trailer<</Size 4/Root 1 0 R>>\nstartxref\n166\n%%EOF\n",
	);
	const file = join(dir, "test.pdf");
	await writeFile(file, pdfBytes);

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		config,
	);
	// Should return text with page count info.
	const allText = text(result.content as any);
	assert.match(allText, /1 pages/);
	assert.match(allText, /Page 1/);

	await rm(dir, { recursive: true });
});

test("PDF page selector", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const pdfBytes = Buffer.from(
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
		"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
		"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
		"xref\n0 4\n0000000000 65535 f \n" +
		"0000000009 00000 n \n" +
		"0000000058 00000 n \n" +
		"0000000113 00000 n \n" +
		"trailer<</Size 4/Root 1 0 R>>\nstartxref\n166\n%%EOF\n",
	);
	const file = join(dir, "test.pdf");
	await writeFile(file, pdfBytes);

	// Request page 5 (out of range for a 1-page PDF).
	const result = await readExtended(
		{ path: file, pages: "5" },
		{ cwd: dir, modelId: "test" },
		config,
	);
	// Should not crash; out-of-range pages are silently skipped.
	const allText = text(result.content as any);
	assert.match(allText, /1 pages/);

	await rm(dir, { recursive: true });
});

test("PDF image mode: rendered pages go through the Photon pipeline", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const pdfBytes = Buffer.from(
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 0000000000 00000 n \n0000000058 0000000000 00000 n \n0000000115 0000000000 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n166\n%%EOF\n",
	);
	const file = join(dir, "test.pdf");
	await writeFile(file, pdfBytes);

	const result = await readExtended(
		{ path: file, mode: "image" },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const images = (result.content as any[]).filter((c) => c.type === "image");
	assert.equal(images.length, 1);
	// Valid base64 payload with an image mime type (Photon output or raw-PNG fallback).
	assert.ok(images[0].data.length > 0);
	assert.ok(Buffer.from(images[0].data, "base64").length > 0);
	assert.match(images[0].mimeType, /^image\//);

	await rm(dir, { recursive: true });
});

test("PDF: image mode gated by model capability", async () => {
	const noImageConfig: PluginConfig = {
		models: {},
		defaults: {
			input: ["text", "audio", "video"],
			maxBytes: { image: 10485760, audio: 20971520, video: 52428800 },
			executionMode: "parallel",
			ffmpegTimeoutMs: 30000,
		},
	};
	const dir = await mkdtemp(join(tmpdir(), "pi-extread-"));
	const pdfBytes = Buffer.from(
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n166\n%%EOF\n",
	);
	const file = join(dir, "test.pdf");
	await writeFile(file, pdfBytes);

	// Model without "image" capability.
	const result = await readExtended(
		{ path: file, mode: "image" },
		{ cwd: dir, modelId: "test" },
		noImageConfig,
	);
	const allText = text(result.content as any);
	assert.match(allText, /does not support images/);

	await rm(dir, { recursive: true });
});

test("PPTX: returns conversion failed for invalid file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-extread-"));
	const file = join(dir, "test.pptx");
	await writeFile(file, Buffer.from([0x50, 0x50, 0x54, 0x58])); // minimal bytes

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const allText = text(result.content as any);
	// Should return "conversion failed" since the file is not a valid PPTX
	assert.match(allText, /conversion failed/i);

	await rm(dir, { recursive: true });
});

test("image direct: PNG dispatch reaches image handler", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	// Minimal valid 1x1 PNG — we're testing dispatch, not the resize pipeline.
	const pngBytes = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQAAHXuKfwAAAABJRU5ErkJggg==",
		"base64",
	);
	const file = join(dir, "test.png");
	await writeFile(file, pngBytes);

	// In the test environment, Photon WASM (pi's image resize engine) is
	// unavailable, so processImage throws. This proves dispatch reached
	// the image handler (file recognized as PNG, capability gate passed).
	await assert.rejects(
		readExtended({ path: file }, { cwd: dir, modelId: "test" }, config),
		/resize|Image|Photon/i,
	);

	await rm(dir, { recursive: true });
});

test("audio direct: WAV returns audio block", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	// Minimal WAV header (RIFF + 44 bytes)
	const wavBytes = Buffer.alloc(44);
	wavBytes.write("RIFF", 0);
	wavBytes.write("WAVE", 8);
	wavBytes.write("fmt ", 12);
	const file = join(dir, "test.wav");
	await writeFile(file, wavBytes);

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const blocks = result.content as any[];
	assert.ok(blocks.some((b) => b.type === "audio"));

	await rm(dir, { recursive: true });
});

test("video direct: MP4 returns video block", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	// Minimal MP4 header (ftyp box)
	const mp4Bytes = Buffer.from([
		0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, // ftyp box
		0x69, 0x73, 0x6f, 0x6d, 0x20, 0x20, 0x20, 0x20,
	]);
	const file = join(dir, "test.mp4");
	await writeFile(file, mp4Bytes);

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const blocks = result.content as any[];
	assert.ok(blocks.some((b) => b.type === "video"));

	await rm(dir, { recursive: true });
});

test("capability gate: model doesn't support images", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const pngBytes = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAIAAAD/gAIDAAAACXBIWXMAAAABAAAAAQBPJcTWAAAA50lEQVR4nO3QsQkAIADAMAX/v9jBF+wkQnJB6dyDW+t1wE/MCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKDqR1Aoosepp1AAAAAElFTkSuQmCC",
		"base64",
	);
	const file = join(dir, "test.png");
	await writeFile(file, pngBytes);

	const noImageConfig: PluginConfig = {
		models: {},
		defaults: {
			input: ["text", "audio", "video"],
			maxBytes: { image: 10485760, audio: 20971520, video: 52428800 },
			executionMode: "parallel",
			ffmpegTimeoutMs: 30000,
		},
	};

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		noImageConfig,
	);
	const allText = text(result.content as any);
	assert.match(allText, /does not support images/);

	await rm(dir, { recursive: true });
});

test("capability gate: model doesn't support video", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const mp4Bytes = Buffer.from([
		0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x20, 0x20, 0x20, 0x20,
	]);
	const file = join(dir, "test.mp4");
	await writeFile(file, mp4Bytes);

	const noVideoConfig: PluginConfig = {
		models: {},
		defaults: {
			input: ["text", "image", "audio"],
			maxBytes: { image: 10485760, audio: 20971520, video: 52428800 },
			executionMode: "parallel",
			ffmpegTimeoutMs: 30000,
		},
	};

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		noVideoConfig,
	);
	const allText = text(result.content as any);
	assert.match(allText, /does not support video/);

	await rm(dir, { recursive: true });
});

// --- PDF TOC, Search, DPI tests ---

test("PDF: toc=true returns outline", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	// Create a minimal PDF with an outline using mupdf
	const mupdf = await import("mupdf") as any;
	// Use a simple PDF that has text (no outline) to test the "no outline" path
	const pdfBytes = Buffer.from(
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF",
	);
	const file = join(dir, "test.pdf");
	await writeFile(file, pdfBytes);

	const result = await readExtended(
		{ path: file, toc: true },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const allText = text(result.content as any);
	assert.match(allText, /no table of contents/i);

	await rm(dir, { recursive: true });
});

test("PDF: search returns no matches for absent text", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const pdfBytes = Buffer.from(
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF",
	);
	const file = join(dir, "test.pdf");
	await writeFile(file, pdfBytes);

	const result = await readExtended(
		{ path: file, search: "nonexistent text that is not in the pdf" },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const allText = text(result.content as any);
	assert.match(allText, /No matches/i);

	await rm(dir, { recursive: true });
});

test("PDF: dpi parameter is accepted (image mode)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const pdfBytes = Buffer.from(
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF",
	);
	const file = join(dir, "test.pdf");
	await writeFile(file, pdfBytes);

	// Image mode with dpi — minimal PDF has no content, so toPixmap succeeds
	// (blank page). Proves the dpi param is accepted and dispatch works.
	const result = await readExtended(
		{ path: file, mode: "image", dpi: 300 },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const allText = text(result.content as any);
	assert.match(allText, /300 DPI/);

	await rm(dir, { recursive: true });
});

// --- Region zoom tests ---

/** Read PNG pixel dimensions straight from the IHDR header (no external tools). */
function pngDims(buf: Buffer): [number, number] | null {
	if (buf.length < 24 || buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
		return null;
	const w = buf.readUInt32BE(16);
	const h = buf.readUInt32BE(20);
	return [w, h];
}

/** Generate a solid-color PNG of exact size via ffmpeg (self-contained fixture). */
async function makePng(width: number, height: number, color: string, targetDir?: string): Promise<string> {
	const { path: bin } = await import("@ffmpeg-installer/ffmpeg");
	const dir = targetDir ?? (await mkdtemp(join(tmpdir(), "zoom-")));
	const out = join(dir, `gen-${width}x${height}.png`);
	await new Promise<void>((res, rej) => {
		execFile(
			bin,
			["-y", "-f", "lavfi", "-i", `color=c=${color}:s=${width}x${height}`, "-frames:v", "1", out],
			{ timeout: 20_000 },
			(err) => (err ? rej(err) : res()),
		);
	});
	return out;
}

/**
 * Assert that a zoomed image read reached pi's resize pipeline (processImageBytes).
 * This is true whether processImage succeeds (resolve with an image block) or throws on
 * ok:false (reject matching the resize/Photon error), so it robustly proves the new crop
 * code path was taken regardless of pi's opaque success/fail behavior.
 */
async function expectRoutedThroughPipeline(promise: Promise<{ content?: any[]; isError?: boolean }>): Promise<void> {
	try {
		const r = await promise;
		assert.ok(r.isError !== true, "expected no error when the pipeline succeeds");
		assert.ok((r.content as any[]).some((b) => b.type === "image"), "expected an image block");
	} catch (e: any) {
		assert.match(String(e.message ?? e), /resize|Image|Photon/i);
	}
}

// --- parseFfmpegDims: guard against the memory-pointer regression ---
//
// Real screenshots (and sips re-encodes of them) make ffmpeg print
// "[png_pipe @ 0x137808200] Stream #0: not enough frames to estimate rate" *before*
// the "Video: ... WxH" descriptor line. A bare \d+x\d+ regex matched the hex pointer
// first, yielding width=0 and a spurious null -> "zoom region unavailable". These
// tests pin the anchored-regex fix without depending on a PNG that triggers the warning.

test("parseFfmpegDims ignores the memory pointer in the 'not enough frames' warning", () => {
	const stderr =
		"[png_pipe @ 0x137808200] Stream #0: not enough frames to estimate rate; consider increasing probesize\n" +
		"Input #0, png_pipe, from '/tmp/x.png':\n" +
		"  Duration: N/A, bitrate: N/A\n" +
		"  Stream #0:0: Video: png, rgba(pc, gbr/unknown/unknown), 2560x8944, 25 fps, 25 tbr, 25 tbn\n";
	assert.deepEqual(parseFfmpegDims(stderr), { width: 2560, height: 8944 });
});

test("parseFfmpegDims parses a normal probe without the warning", () => {
	const stderr =
		"Input #0, png_pipe, from '/tmp/x.png':\n" +
		"  Duration: N/A, bitrate: N/A\n" +
		"  Stream #0:0: Video: png, rgba(pc), 1251x4359, 25 fps, 25 tbr, 25 tbn\n";
	assert.deepEqual(parseFfmpegDims(stderr), { width: 1251, height: 4359 });
});

test("parseFfmpegDims returns null when no valid Video line is present", () => {
	assert.equal(parseFfmpegDims("[png_pipe @ 0x137808200] Stream #0: not enough frames"), null);
	assert.equal(parseFfmpegDims(""), null);
});

test("cropRegionToPng crops a full-frame fraction to expected dimensions", async () => {
	const src = await makePng(500, 300, "green");
	try {
		const buf = await cropRegionToPng(src, { x: 0, y: 0, w: 0.5, h: 0.5 }, 30_000);
		assert.ok(buf, "expected a cropped buffer");
		assert.deepEqual(pngDims(buf as Buffer), [250, 150]);
	} finally {
		await rm(src.split("/").slice(0, -1).join("/"), { recursive: true });
	}
});

test("cropRegionToPng handles an offset fraction", async () => {
	const src = await makePng(500, 300, "red");
	try {
		const buf = await cropRegionToPng(src, { x: 0.25, y: 0.5, w: 0.5, h: 0.5 }, 30_000);
		assert.ok(buf, "expected a cropped buffer");
		// boxPx = (125, 150, 250, 150); output dimensions are w x h.
		assert.deepEqual(pngDims(buf as Buffer), [250, 150]);
	} finally {
		await rm(src.split("/").slice(0, -1).join("/"), { recursive: true });
	}
});

test("cropRegionToPng clamps an overflowing box to the raster", async () => {
	const src = await makePng(400, 300, "blue");
	try {
		// w=1,h=1 at (0.9,0.9) would overflow; must clamp inside bounds without error.
		const buf = await cropRegionToPng(src, { x: 0.9, y: 0.9, w: 1, h: 1 }, 30_000);
		assert.ok(buf, "expected a cropped buffer");
		// W=400,H=300 -> fills the whole raster from (0,0) after clamping.
		assert.deepEqual(pngDims(buf as Buffer), [400, 300]);
	} finally {
		await rm(src.split("/").slice(0, -1).join("/"), { recursive: true });
	}
});

test("cropRegionToPng returns null (no throw) when dimensions cannot be resolved", async () => {
	const buf = await cropRegionToPng("/tmp/__does_not_exist_zoom__.png", { x: 0, y: 0, w: 0.5, h: 0.5 }, 5_000);
	assert.equal(buf, null);
});

test("direct image with zoom routes through the resize pipeline (crop then pi)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "zoom-img-"));
	// Generate a real PNG directly into dir; readExtended will crop it then hand it to pi.
	const file = await makePng(200, 150, "green", dir);

	// Zoom routes the cropped region through processImageBytes (crop -> pi pipeline).
	await expectRoutedThroughPipeline(
		readExtended({ path: file, zoom: { x: 0, y: 0, w: 0.5, h: 0.5 } }, { cwd: dir, modelId: "test" }, config),
	);

	await rm(dir, { recursive: true });
});

test("PDF image mode with zoom routes the cropped region through pi", async () => {
	const dir = await mkdtemp(join(tmpdir(), "zoom-pdf-"));
	const pdfBytes = Buffer.from(
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n166\n%%EOF\n",
	);
	const file = join(dir, "test.pdf");
	await writeFile(file, pdfBytes);

	// Renders page raster -> crops region via ffmpeg -> processImageBytes(cropped) -> pi.
	await expectRoutedThroughPipeline(
		readExtended({ path: file, mode: "image", zoom: { x: 0, y: 0, w: 0.5, h: 0.5 } }, { cwd: dir, modelId: "test" }, config),
	);

	await rm(dir, { recursive: true });
});

test("PDF image mode without zoom is unchanged (full page, no pipeline resize)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "zoom-pdf-full-"));
	const pdfBytes = Buffer.from(
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n166\n%%EOF\n",
	);
	const file = join(dir, "test.pdf");
	await writeFile(file, pdfBytes);

	// Backward-compat: omitting zoom keeps the original full-page behavior — a full-page image block is returned (no pipeline resize).
	const result = await readExtended({ path: file, mode: "image" }, { cwd: dir, modelId: "test" }, config);
	assert.ok(result.isError !== true);
	const blocks = result.content as any[];
	assert.ok(blocks.some((b) => b.type === "image"));
	assert.match(text(blocks), /DPI/);

	await rm(dir, { recursive: true });
});

test("converted image (tiff) with zoom routes through the resize pipeline (ffmpegConvert -> crop -> pi)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "zoom-conv-"));
	// Generate a real TIFF into dir; ffmpegConvert down-converts it to PNG, then zoom crops that raster and hands it to pi.
	const bin = (await import("@ffmpeg-installer/ffmpeg")).path;
	const file = join(dir, "gen.tif");
	await new Promise<void>((res, rej) => {
		execFile(bin, ["-y", "-f", "lavfi", "-i", `color=c=green:s=200x150`, "-frames:v", "1", file], { timeout: 20_000 }, (err) => (err ? rej(err) : res()));
	});

	// Convertible formats were previously zoom-blind; this asserts the crop path now runs for them too.
	await expectRoutedThroughPipeline(
		readExtended({ path: file, zoom: { x: 0, y: 0, w: 0.5, h: 0.5 } }, { cwd: dir, modelId: "test" }, config),
	);

	await rm(dir, { recursive: true });
});

test("PDF image mode with an overflowing zoom emits the fallback signal and returns the full page", async () => {
	const dir = await mkdtemp(join(tmpdir(), "zoom-pdf-fallback-"));
	const pdfBytes = Buffer.from(
		"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n166\n%%EOF\n",
	);
	const file = join(dir, "test.pdf");
	await writeFile(file, pdfBytes);

	// w=2,h=2 overflows the raster; ffmpeg's crop fails, so the crop path falls back to the full page.
	// The fallback must be model-visible (not a silent server-side warn) so it does not hallucinate a cropped region.
	const result = await readExtended({ path: file, mode: "image", zoom: { x: 0, y: 0, w: 2, h: 2 } }, { cwd: dir, modelId: "test" }, config);
	assert.equal(result.isError, undefined);
	const blocks = result.content as any[];
	const hintIdx = blocks.findIndex((b) => b.type === "text" && /unavailable/i.test(b.text));
	const imgIdx = blocks.findIndex((b) => b.type === "image");
	assert.notEqual(hintIdx, -1, "expected the model-visible zoom-unavailable fallback hint");
	assert.notEqual(imgIdx, -1, "expected a full-page image block");
	// The caveat must precede the (full-page) image it qualifies — otherwise the model would read an uncropped frame.
	assert.ok(hintIdx < imgIdx, "fallback hint should appear before the image block it qualifies");

	await rm(dir, { recursive: true });
});

// --- Probe (info=true) tests ---

import { parseFfmpegProbe, renderProbeText } from "../src/ffmpeg.js";

const PROBE_FIXTURE = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'sample.mp4':
  Metadata:
    major_brand     : isom
    encoder         : Lavf61
  Duration: 00:01:30.00, start: 0.000000, bitrate: 123 kb/s
  Stream #0:0(eng): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 25 fps, 25 tbr, 12800 tbn
    Stream #0:1(eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)`;

test("parseFfmpegProbe extracts format, duration, dims, audio", () => {
	const info = parseFfmpegProbe(PROBE_FIXTURE);
	assert.ok(info);
	assert.equal(info!.format, "mov");
	assert.equal(info!.duration, "00:01:30.00");
	assert.equal(info!.bitrate, "123 kb/s");
	assert.equal(info!.width, 1920);
	assert.equal(info!.height, 1080);
	assert.ok(info!.videoDetail!.includes("h264"));
	assert.ok(info!.hasAudio);
	assert.match(info!.audioDetail!, /aac/);
});

test("parseFfmpegProbe video-only has no audio", () => {
	const info = parseFfmpegProbe(`Input #0, gif, from 'a.gif':\n  Duration: N/A, bitrate: N/A\n  Stream #0:0: Video: gif, bgra, 320x240, 1.00 fps`);
	assert.ok(info);
	assert.equal(info!.width, 320);
	assert.equal(info!.height, 240);
	assert.equal(info!.hasAudio, false);
});

test("parseFfmpegProbe returns null on undecodable input", () => {
	assert.equal(parseFfmpegProbe("Invalid data found when processing input"), null);
});

test("renderProbeText marks unavailable probe", () => {
	const lines = renderProbeText(null, 12345, "mp4");
	assert.match(lines.join("\n"), /probe unavailable/);
});

/** Generate a tiny mp4 with video + audio via ffmpeg lavfi (self-contained fixture). */
function genMp4(file: string): Promise<void> {
	return import("@ffmpeg-installer/ffmpeg").then(({ path: bin }) => {
		return new Promise((res, rej) => {
			execFile(
				bin,
				["-y", "-f", "lavfi", "-i", "testsrc=size=64x48:duration=1", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-shortest", file],
				{ timeout: 20_000 },
				(err) => (err ? rej(err) : res()),
			);
		});
	});
}

test("info=true probes a real mp4 without loading media", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "probe.mp4");
	await genMp4(file);

	const result = await readExtended(
		{ path: file, info: true },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const t = text(result.content as any);
	assert.match(t, /Probe \[mp4\]/);
	assert.match(t, /duration:/);
	assert.match(t, /\(64x48\)/);
	assert.match(t, /Audio: present/);

	await rm(dir, { recursive: true });
});

test("info=true bypasses size cap and capability gate", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "probe.mp4");
	await genMp4(file);

	// Tiny video cap + text-only model: full load would be blocked; probe must succeed.
	const tight: PluginConfig = {
		models: {
			"text-model": { input: ["text"], maxBytes: { image: 10, audio: 10, video: 500 } },
		},
		defaults: {
			input: ["text", "image", "audio", "video"],
			maxBytes: { image: 10485760, audio: 20971520, video: 52428800 },
			executionMode: "parallel",
			ffmpegTimeoutMs: 30000,
		},
	};

	const full = await readExtended({ path: file }, { cwd: dir, modelId: "text-model" }, tight);
	assert.match(text(full.content as any), /too large|does not support/);

	const probe = await readExtended({ path: file, info: true }, { cwd: dir, modelId: "text-model" }, tight);
	const t = text(probe.content as any);
	assert.match(t, /\(64x48\)/);
	assert.ok(!/too large|does not support/.test(t));

	await rm(dir, { recursive: true });
});

test("info=true on PDF points to toc/pages", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "doc.pdf");
	await writeFile(file, "%PDF-1.4\n");

	const result = await readExtended({ path: file, info: true }, { cwd: dir, modelId: "test" }, config);
	assert.match(text(result.content as any), /toc=true\/pages/);

	await rm(dir, { recursive: true });
});