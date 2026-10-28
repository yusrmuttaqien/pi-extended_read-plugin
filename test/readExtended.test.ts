/**
 * readExtended.test.ts — tests for the extendedRead tool.
 *
 * Tests the dispatch logic: resolve, stat, size cap, capability gate,
 * format dispatch, the image gate, video frames, and error handling.
 */

import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

import { readExtended } from "../src/readExtended.js";
import { cropRegion, parseFfmpegDims, parseFfmpegProbe, renderProbeText } from "../src/ffmpeg.js";
import type { PluginConfig } from "../src/config.js";
import type { AgentToolResult } from "../src/readExtended.js";

/** Extract text from array content. */
function text(content: AgentToolResult["content"]): string {
	return content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

const config: PluginConfig = {
	models: {},
	defaults: {
		input: ["text", "image"],
		maxBytes: { image: 10485760 },
		imageGate: { maxDim: 2000, maxBytes: 4718592, jpegQuality: 80 },
		executionMode: "parallel",
		ffmpegTimeoutMs: 30000,
	},
};

// --- Basic dispatch ---

test("file not found", async () => {
	const result = await readExtended(
		{ path: "/nonexistent/file.png" },
		{ cwd: "/tmp", modelId: "test" },
		config,
	);
	assert.equal(result.isError, true);
	assert.match(text(result.content), /File not found/);
});

test("not a file (directory)", async () => {
	const result = await readExtended(
		{ path: "/tmp" },
		{ cwd: "/tmp", modelId: "test" },
		config,
	);
	assert.equal(result.isError, true);
	assert.match(text(result.content), /Not a file/);
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
	assert.match(text(result.content), /unsupported format/);

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
	assert.match(text(result.content), /File too large/);

	await rm(dir, { recursive: true });
});

test("tilde expansion", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "test.txt");
	await writeFile(file, "hello");

	// Use ~ in the path (should expand to homedir).
	const result = await readExtended(
		{ path: `~/${file.split("/").pop()}` },
		{ cwd: dir, modelId: "test" },
		config,
	);
	// Should be "File not found" (since the file isn't actually in homedir).
	assert.equal(result.isError, true);

	await rm(dir, { recursive: true });
});

// --- Capability gate ---

test("capability gate: model doesn't support images", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "test.png");
	await writeFile(file, Buffer.alloc(10));

	const noImageConfig: PluginConfig = {
		models: {},
		defaults: {
			input: ["text"],
			maxBytes: { image: 10485760 },
			executionMode: "parallel",
			ffmpegTimeoutMs: 30000,
		},
	};

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		noImageConfig,
	);
	assert.match(text(result.content), /does not support images/);

	await rm(dir, { recursive: true });
});

// --- Image gate ---

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

test("image direct: small PNG passes the gate and returns an image block", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = await makePng(100, 80, "green", dir);

	const result = await readExtended({ path: file }, { cwd: dir, modelId: "test" }, config);
	assert.equal(result.isError, undefined);
	const images = (result.content as { type: string; data?: string; mimeType?: string }[]).filter((b) => b.type === "image");
	assert.equal(images.length, 1);
	assert.ok(Buffer.from(images[0].data!, "base64").length > 0);

	await rm(dir, { recursive: true });
});

test("gate: over-limit direct PNG is downscaled to maxDim (re-encoded as PNG)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = await makePng(3000, 2000, "green", dir);

	const result = await readExtended({ path: file }, { cwd: dir, modelId: "test" }, config);
	assert.equal(result.isError, undefined);
	const images = (result.content as { type: string; data?: string; mimeType?: string }[]).filter((b) => b.type === "image");
	assert.equal(images.length, 1);
	// Direct formats re-encode in their own format (never cross-converted).
	assert.equal(images[0].mimeType, "image/png");
	const dims = pngDims(Buffer.from(images[0].data!, "base64"));
	assert.ok(dims, "expected a decodable PNG");
	assert.ok(dims![0] <= 2000 && dims![1] <= 2000, `expected dims within maxDim, got ${dims![0]}x${dims![1]}`);

	await rm(dir, { recursive: true });
});

/** Generate a multi-frame animated GIF via ffmpeg (regression fixture). */
async function makeMultiFrameGif(targetDir: string): Promise<string> {
	const { path: bin } = await import("@ffmpeg-installer/ffmpeg");
	const out = join(targetDir, "gen-multi.gif");
	await new Promise<void>((res, rej) => {
		execFile(
			bin,
			["-y", "-f", "lavfi", "-i", "color=c=blue:s=2100x1500:r=2:d=1", out],
			{ timeout: 20_000 },
			(err) => (err ? rej(err) : res()),
		);
	});
	return out;
}

test("gate: over-limit multi-frame GIF re-encodes to a single PNG (first frame)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = await makeMultiFrameGif(dir);

	const result = await readExtended({ path: file }, { cwd: dir, modelId: "test" }, config);
	assert.equal(result.isError, undefined);
	const images = (result.content as { type: string; data?: string; mimeType?: string }[]).filter((b) => b.type === "image");
	assert.equal(images.length, 1);
	// Direct formats re-encode in their own format (gif → png, first frame).
	assert.equal(images[0].mimeType, "image/png");
	assert.ok(images[0].data!.length > 0);

	await rm(dir, { recursive: true });
});

// --- Audio: probe-only ---

test("audio: WAV returns a probe-only note (no media block)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
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
	const allText = text(result.content);
	assert.match(allText, /audio support removed/);
	assert.match(allText, /info=true/);
	const blocks = result.content as { type: string }[];
	assert.ok(!blocks.some((b) => b.type !== "text"), "expected no media blocks");

	await rm(dir, { recursive: true });
});

// --- Video: frames ---

/** Generate a tiny mp4 with video via ffmpeg lavfi (self-contained fixture). */
async function genMp4(file: string, seconds = 2): Promise<void> {
	const { path: bin } = await import("@ffmpeg-installer/ffmpeg");
	await new Promise<void>((res, rej) => {
		execFile(
			bin,
			["-y", "-f", "lavfi", "-i", `testsrc=size=64x48:rate=25:duration=${seconds}`, "-pix_fmt", "yuv420p", file],
			{ timeout: 30_000 },
			(err) => (err ? rej(err) : res()),
		);
	});
}

test("video: 2s mp4 auto-frames to two image blocks (auto minimum)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "test.mp4");
	await genMp4(file, 2);

	const result = await readExtended({ path: file }, { cwd: dir, modelId: "test" }, config);
	assert.equal(result.isError, undefined);
	const images = (result.content as { type: string; data?: string; mimeType?: string }[]).filter((b) => b.type === "image");
	assert.equal(images.length, 2);
	assert.equal(images[0].mimeType, "image/jpeg");
	assert.match(text(result.content), /2 frames/);
	assert.match(text(result.content), /audio/);

	await rm(dir, { recursive: true });
});

test("video: frames=3 extracts three frames", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "test.mp4");
	await genMp4(file, 4);

	const result = await readExtended({ path: file, frames: 3 }, { cwd: dir, modelId: "test" }, config);
	assert.equal(result.isError, undefined);
	const images = (result.content as { type: string }[]).filter((b) => b.type === "image");
	assert.equal(images.length, 3);
	assert.match(text(result.content), /3 frames/);

	await rm(dir, { recursive: true });
});

test("video: frames=0 returns a validation note", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "test.mp4");
	await genMp4(file, 2);

	const result = await readExtended({ path: file, frames: 0 }, { cwd: dir, modelId: "test" }, config);
	assert.match(text(result.content), /frames must be between 1 and 16/);

	await rm(dir, { recursive: true });
});

test("video: frames=17 returns a validation note", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "test.mp4");
	await genMp4(file, 2);

	const result = await readExtended({ path: file, frames: 17 }, { cwd: dir, modelId: "test" }, config);
	assert.match(text(result.content), /frames must be between 1 and 16/);

	await rm(dir, { recursive: true });
});

test("video: extraction failure returns a note (no crash)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	// Fake mp4 header — probe fails.
	const file = join(dir, "test.mp4");
	await writeFile(file, Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]));

	const result = await readExtended({ path: file }, { cwd: dir, modelId: "test" }, config);
	assert.match(text(result.content), /frame extraction failed/);

	await rm(dir, { recursive: true });
});

test("video: capability gate (no image support)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "test.mp4");
	await genMp4(file, 2);

	const noImageConfig: PluginConfig = {
		models: {},
		defaults: {
			input: ["text"],
			maxBytes: { image: 10485760 },
			executionMode: "parallel",
			ffmpegTimeoutMs: 30000,
		},
	};

	const result = await readExtended({ path: file }, { cwd: dir, modelId: "test" }, noImageConfig);
	assert.match(text(result.content), /does not support images/);

	await rm(dir, { recursive: true });
});

// --- PDF ---

const PDF_BYTES = Buffer.from(
	"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
	"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
	"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
	"xref\n0 4\n0000000000 65535 f \n" +
	"0000000009 00000 n \n" +
	"0000000058 00000 n \n" +
	"0000000113 00000 n \n" +
	"trailer<</Size 4/Root 1 0 R>>\nstartxref\n166\n%%EOF\n",
);

test("PDF text extraction", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "test.pdf");
	await writeFile(file, PDF_BYTES);

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const allText = text(result.content);
	assert.match(allText, /1 pages/);
	assert.match(allText, /Page 1/);

	await rm(dir, { recursive: true });
});

test("PDF page selector", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "test.pdf");
	await writeFile(file, PDF_BYTES);

	// Request page 5 (out of range for a 1-page PDF).
	const result = await readExtended(
		{ path: file, pages: "5" },
		{ cwd: dir, modelId: "test" },
		config,
	);
	// Should not crash; out-of-range pages are silently skipped.
	const allText = text(result.content);
	assert.match(allText, /1 pages/);

	await rm(dir, { recursive: true });
});

test("PDF image mode: rendered pages go through the gate (JPEG)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "test.pdf");
	await writeFile(file, PDF_BYTES);

	const result = await readExtended(
		{ path: file, mode: "image" },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const images = (result.content as { type: string; data?: string; mimeType?: string }[]).filter((c) => c.type === "image");
	assert.equal(images.length, 1);
	assert.ok(images[0].data!.length > 0);
	assert.ok(Buffer.from(images[0].data!, "base64").length > 0);
	assert.match(images[0].mimeType!, /^image\//);

	await rm(dir, { recursive: true });
});

test("PDF: image mode gated by model capability", async () => {
	const noImageConfig: PluginConfig = {
		models: {},
		defaults: {
			input: ["text"],
			maxBytes: { image: 10485760 },
			executionMode: "parallel",
			ffmpegTimeoutMs: 30000,
		},
	};
	const dir = await mkdtemp(join(tmpdir(), "pi-extread-"));
	const file = join(dir, "test.pdf");
	await writeFile(file, PDF_BYTES);

	const result = await readExtended(
		{ path: file, mode: "image" },
		{ cwd: dir, modelId: "test" },
		noImageConfig,
	);
	const allText = text(result.content);
	assert.match(allText, /does not support images/);

	await rm(dir, { recursive: true });
});

test("PDF: toc=true returns outline", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "test.pdf");
	await writeFile(file, PDF_BYTES);

	const result = await readExtended(
		{ path: file, toc: true },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const allText = text(result.content);
	assert.match(allText, /no table of contents/i);

	await rm(dir, { recursive: true });
});

test("PDF: search returns no matches for absent text", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "test.pdf");
	await writeFile(file, PDF_BYTES);

	const result = await readExtended(
		{ path: file, search: "nonexistent text that is not in the pdf" },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const allText = text(result.content);
	assert.match(allText, /No matches/i);

	await rm(dir, { recursive: true });
});

test("PDF: dpi parameter is accepted (image mode)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "test.pdf");
	await writeFile(file, PDF_BYTES);

	const result = await readExtended(
		{ path: file, mode: "image", dpi: 300 },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const allText = text(result.content);
	assert.match(allText, /300 DPI/);

	await rm(dir, { recursive: true });
});

// --- PPTX ---

test("PPTX: returns conversion failed for invalid file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-extread-"));
	const file = join(dir, "test.pptx");
	await writeFile(file, Buffer.from([0x50, 0x50, 0x54, 0x58])); // minimal bytes

	const result = await readExtended(
		{ path: file },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const allText = text(result.content);
	assert.match(allText, /conversion failed/i);

	await rm(dir, { recursive: true });
});

// --- parseFfmpegDims: guard against the memory-pointer regression ---

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

// --- cropRegion ---

test("cropRegion crops a full-frame fraction to expected dimensions", async () => {
	const src = await makePng(500, 300, "green");
	try {
		const out = await cropRegion(src, { x: 0, y: 0, w: 0.5, h: 0.5 }, "png", 30_000);
		assert.ok(out, "expected a cropped file");
		const buf = await readFile(out!);
		assert.deepEqual(pngDims(buf), [250, 150]);
	} finally {
		await rm(src.split("/").slice(0, -1).join("/"), { recursive: true });
	}
});

test("cropRegion handles an offset fraction", async () => {
	const src = await makePng(500, 300, "red");
	try {
		const out = await cropRegion(src, { x: 0.25, y: 0.5, w: 0.5, h: 0.5 }, "png", 30_000);
		assert.ok(out, "expected a cropped file");
		const buf = await readFile(out!);
		assert.deepEqual(pngDims(buf), [250, 150]);
	} finally {
		await rm(src.split("/").slice(0, -1).join("/"), { recursive: true });
	}
});

test("cropRegion clamps an overflowing box to the raster", async () => {
	const src = await makePng(400, 300, "blue");
	try {
		// w=1,h=1 at (0.9,0.9) would overflow; must clamp inside bounds without error.
		const out = await cropRegion(src, { x: 0.9, y: 0.9, w: 1, h: 1 }, "png", 30_000);
		assert.ok(out, "expected a cropped file");
		const buf = await readFile(out!);
		// W=400,H=300 -> fills the whole raster from (0,0) after clamping.
		assert.deepEqual(pngDims(buf), [400, 300]);
	} finally {
		await rm(src.split("/").slice(0, -1).join("/"), { recursive: true });
	}
});

test("cropRegion returns null (no throw) when dimensions cannot be resolved", async () => {
	const out = await cropRegion("/tmp/__does_not_exist_zoom__.png", { x: 0, y: 0, w: 0.5, h: 0.5 }, "png", 5_000);
	assert.equal(out, null);
});

test("direct image with zoom: crop then gate returns an image block", async () => {
	const dir = await mkdtemp(join(tmpdir(), "zoom-img-"));
	const file = await makePng(200, 150, "green", dir);

	const result = await readExtended(
		{ path: file, zoom: { x: 0, y: 0, w: 0.5, h: 0.5 } },
		{ cwd: dir, modelId: "test" },
		config,
	);
	assert.equal(result.isError, undefined);
	const images = (result.content as { type: string }[]).filter((b) => b.type === "image");
	assert.ok(images.length >= 1, "expected an image block");

	await rm(dir, { recursive: true });
});

test("PDF image mode with zoom: crop then gate returns an image block", async () => {
	const dir = await mkdtemp(join(tmpdir(), "zoom-pdf-"));
	const file = join(dir, "test.pdf");
	await writeFile(file, PDF_BYTES);

	const result = await readExtended(
		{ path: file, mode: "image", zoom: { x: 0, y: 0, w: 0.5, h: 0.5 } },
		{ cwd: dir, modelId: "test" },
		config,
	);
	assert.equal(result.isError, undefined);
	const images = (result.content as { type: string }[]).filter((b) => b.type === "image");
	assert.ok(images.length >= 1, "expected an image block");

	await rm(dir, { recursive: true });
});

test("PDF image mode without zoom: full page image block", async () => {
	const dir = await mkdtemp(join(tmpdir(), "zoom-pdf-full-"));
	const file = join(dir, "test.pdf");
	await writeFile(file, PDF_BYTES);

	const result = await readExtended({ path: file, mode: "image" }, { cwd: dir, modelId: "test" }, config);
	assert.ok(result.isError !== true);
	const blocks = result.content as { type: string }[];
	assert.ok(blocks.some((b) => b.type === "image"));
	assert.match(text(result.content), /DPI/);

	await rm(dir, { recursive: true });
});

test("converted image (tiff) with zoom: convert, crop, gate", async () => {
	const dir = await mkdtemp(join(tmpdir(), "zoom-conv-"));
	const bin = (await import("@ffmpeg-installer/ffmpeg")).path;
	const file = join(dir, "gen.tif");
	await new Promise<void>((res, rej) => {
		execFile(bin, ["-y", "-f", "lavfi", "-i", `color=c=green:s=200x150`, "-frames:v", "1", file], { timeout: 20_000 }, (err) => (err ? rej(err) : res()));
	});

	const result = await readExtended(
		{ path: file, zoom: { x: 0, y: 0, w: 0.5, h: 0.5 } },
		{ cwd: dir, modelId: "test" },
		config,
	);
	assert.equal(result.isError, undefined);
	const images = (result.content as { type: string }[]).filter((b) => b.type === "image");
	assert.ok(images.length >= 1, "expected an image block");

	await rm(dir, { recursive: true });
});

test("PDF image mode with an overflowing zoom emits the fallback hint and returns the full page", async () => {
	const dir = await mkdtemp(join(tmpdir(), "zoom-pdf-fallback-"));
	const file = join(dir, "test.pdf");
	await writeFile(file, PDF_BYTES);

	// w=2,h=2 overflows the raster; the crop falls back to the full page.
	const result = await readExtended({ path: file, mode: "image", zoom: { x: 0, y: 0, w: 2, h: 2 } }, { cwd: dir, modelId: "test" }, config);
	assert.equal(result.isError, undefined);
	const blocks = result.content as { type: string; text?: string }[];
	const hintIdx = blocks.findIndex((b) => b.type === "text" && /unavailable/i.test(b.text ?? ""));
	const imgIdx = blocks.findIndex((b) => b.type === "image");
	assert.notEqual(hintIdx, -1, "expected the model-visible zoom-unavailable fallback hint");
	assert.notEqual(imgIdx, -1, "expected a full-page image block");
	assert.ok(hintIdx < imgIdx, "fallback hint should appear before the image block it qualifies");

	await rm(dir, { recursive: true });
});

// --- Probe (info=true) ---

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

test("info=true probes a real mp4 without loading media", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "probe.mp4");
	await genMp4(file, 1);

	const result = await readExtended(
		{ path: file, info: true },
		{ cwd: dir, modelId: "test" },
		config,
	);
	const t = text(result.content);
	assert.match(t, /Probe \[mp4\]/);
	assert.match(t, /duration:/);
	assert.match(t, /\(64x48\)/);

	await rm(dir, { recursive: true });
});

test("info=true bypasses capability gate", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "probe.mp4");
	await genMp4(file, 1);

	// Text-only model: full load is blocked by the capability gate; probe must succeed.
	const tight: PluginConfig = {
		models: {
			"text-model": { input: ["text"], maxBytes: { image: 10 } },
		},
		defaults: {
			input: ["text", "image"],
			maxBytes: { image: 10485760 },
			executionMode: "parallel",
			ffmpegTimeoutMs: 30000,
		},
	};

	const full = await readExtended({ path: file }, { cwd: dir, modelId: "text-model" }, tight);
	assert.match(text(full.content), /does not support images/);

	const probe = await readExtended({ path: file, info: true }, { cwd: dir, modelId: "text-model" }, tight);
	const t = text(probe.content);
	assert.match(t, /\(64x48\)/);
	assert.ok(!/does not support/.test(t));

	await rm(dir, { recursive: true });
});

test("info=true on PDF points to toc/pages", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extread-"));
	const file = join(dir, "doc.pdf");
	await writeFile(file, "%PDF-1.4\n");

	const result = await readExtended({ path: file, info: true }, { cwd: dir, modelId: "test" }, config);
	assert.match(text(result.content), /toc=true\/pages/);

	await rm(dir, { recursive: true });
});
