# `extendedRead` — Design Spec

A model-invoked tool that reads media files (images, video, PDF, PPTX) and returns them as attachments the model can perceive. Complements the native `read` tool (text) by adding images through a bundled-ffmpeg gate, video as frames, PDF reading, and PPTX. Audio is probe-only (`info=true`).

## 1. Goal

Provide the model with a dedicated tool for media files. The native `read` tool handles text. `extendedRead` extends this to:

- **Images** (png, jpg, jpeg, gif, webp, bmp direct; heic, heif, tiff, tif, tga, avif converted) — every raster gated: bounded dimensions and bytes, JPEG for derived output.
- **Video** (mp4, webm, mkv, mov, avi) — read as evenly spaced JPEG frames; audio omitted (noted).
- **PDF** (text extraction + visual page rendering, with pagination).
- **PPTX** (converts to PDF via @s8fy/pptx-converter, then uses the PDF pipeline).
- **Audio** (wav, mp3, flac, ogg, aiff, aif, m4a, aac, wma, opus) — probe-only metadata via `info=true`.
- **Region-finding (trace)** — for static images + PDF image mode: `trace={}` overlays numbered guiding lines (0-100 coords) so the model can read coordinates; `trace={x,y,w,h}` (0-100) crops the untraced original at those coords.

Media enters the context **lazily** — only when the model calls the tool.

## 2. Design principles

| Principle | Choice |
|---|---|
| Media enters context | Lazily, only on tool call |
| Images | Bundled-ffmpeg **gate** (see §6) — bounded dims/bytes, JPEG for derived rasters |
| Video | `ffmpeg` → evenly spaced JPEG frames (each gated) |
| Serialization | **Native mechanism** — tool emits only `image` blocks; pi's `convertMessages` serializes them natively. No hook, no marker, **no patch**. |
| Format handling | Deterministic; same support matrix across platforms |
| Cleanup | OS-managed `/tmp`; no bookkeeping |
| Configuration | User-editable `config.json` with self-documenting `$docs` key |

## 3. Config file

Location: `~/.pi/agent/extensions/pi-extendedread/config.json`

The config is **self-documenting**: a `$docs` key describes every other key and its valid values.

```json
{
  "models": {
    "my-model": {
      "input": ["text", "image"],
      "maxBytes": { "image": 10485760 }
    }
  },
  "defaults": {
    "input": ["text", "image"],
    "maxBytes": { "image": 10485760 },
    "imageGate": {
      "maxDim": 2000,
      "maxBytes": 4718592,
      "jpegQuality": 80
    },
    "executionMode": "parallel",
    "ffmpegTimeoutMs": 30000,
    "pdf": {
      "defaultDpi": 150,
      "maxPagesPerCall": 10
    }
  }
}
```

**Capability gating:** the tool checks `config.models[modelId].input` (or `defaults.input`) before returning image blocks. If the model doesn't list `"image"`, image/video/PDF-image-mode returns a text note (`"Model does not support images"`) instead of media. This replaces pi's `model.input.includes("image")` gate with a user-configurable equivalent.

**Gate options** (`imageGate`): `maxDim` (2000) — max raster dimension after the gate; `maxBytes` (4718592, 4.5 MB base64) — byte budget for the serialized image; `jpegQuality` (80) — starting quality for the JPEG ladder. Values mirror pi's Photon defaults.

## 4. Tool definition

Registered via `pi.registerTool(...)` (see `dist/core/extensions/types.d.ts`, `ToolDefinition`).

```ts
defineTool({
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
  executionMode: config.defaults.executionMode,
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    return await readExtended(params, ctx);
  },
});
```

## 5. Behavior / dispatch

```ts
async function readExtended(params, ctx): Promise<AgentToolResult> {
  // 1. Resolve
  const path = resolve(ctx.cwd, expandTilde(params.path));

  // 2. Stat
  let stat;
  try { stat = await fs.stat(path); }
  catch { return err(`File not found: ${path}`); }
  if (!stat.isFile()) return err(`Not a file: ${path}`);

  const ext = extname(path).toLowerCase().slice(1);
  const modality = modalityOf(ext); // "image" | "video" | "audio" | null
  const input = modelInput(ctx.modelId); // from config

  // 3. Info probe: metadata-only first look for ffmpeg-decodable media.
  // Runs before the size cap and capability gate so a large file can be
  // inspected before deciding how to load it; result is plain text.
  if (params.info) {
    return modality
      ? ok(renderProbeText(await probeMedia(path), stat.size, ext))
      : note(`info works on image/audio/video; for PDF use toc=true/pages`);
  }

  // 4. Audio: probe-only (support removed).
  if (modality === "audio")
    return note(`Audio [${ext}] — audio support removed; probe with info=true`);

  // 5. Video: evenly spaced JPEG frames (bypasses the size cap).
  if (modality === "video") {
    if (!input.includes("image")) return note("Model does not support images");
    const result = await readVideoFrames(path, params.frames, gateOpts);
    if (!result) return note(`frame extraction failed (ffmpeg)`);
    return ok([txt(result.legend), ...result.frames.flatMap(f => [txt(f.caption), img(f.data, "image/jpeg")])]);
  }

  // 6. Size cap (images only, no trace — trace/crop bypass; the gate bounds output).
  if (modality === "image" && !params.trace && stat.size > maxBytes.image)
    return note(`File too large (${stat.size} > ${maxBytes.image} bytes for image)`);

  // 7. Capability gate (images).
  if (!input.includes("image")) return note("Model does not support images");

  // 8. Image direct: native format — pass through within limits,
  //    re-encode in own format over limits (gate). Trace/crop routes to processTrace.
  if (IMAGE_DIRECT[ext])
    return params.trace
      ? processTrace(path, MIME[ext], params.trace)
      : processImageContent(path, MIME[ext], "same");

  // 9. Image converted: non-native format — gate to JPEG.
  if (IMAGE_CONVERT[ext])
    return params.trace
      ? processTrace(path, MIME[ext], params.trace)
      : processImageContent(path, MIME[ext], "jpeg");

  // 10. PDF
  if (ext === "pdf") return readPdf(path, params, config, input, ctx.sessionId);

  // 11. PPTX (convert to PDF via @s8fy/pptx-converter)
  if (ext === "pptx") return readPptx(path, params, config, input, ctx.sessionId);

  // 12. Unsupported
  return note(`[extendedRead: unsupported format ${ext}]`);
}
```

Mirrors native `read`'s flow: resolve → stat → detect → process → return. Difference: extension-based dispatch (vs. magic bytes), capability gating, and media branches.

## 6. Media handling

### Format support matrix

| Modality | Direct (no conversion) | Converted via `ffmpeg` → target |
|---|---|---|
| Image | png, jpg, jpeg, gif, webp, bmp | heic, heif, tiff, tif, tga, avif → **jpeg** |
| Video | mp4, webm, mkv, mov, avi → **jpeg frames** | — |
| Audio | wav, mp3, flac, ogg, aiff, aif, m4a, aac, wma, opus → **probe-only** | — |
| PPTX | — | pptx → **pdf** (via @s8fy/pptx-converter) |

### Image gate (`src/gate.ts`)

Every raster this tool emits passes through the gate before serialization:

- **Direct formats** pass through **byte-identical** when within limits (dims ≤ `maxDim`, base64 ≤ `maxBytes`). Over-limit direct images are re-encoded **in their own format** (never cross-converted).
- **Derived rasters** (converted formats, video frames, PDF renders, trace crops) are encoded to **JPEG**.
- Pipeline: `autorotate` (EXIF orientation, when the bundled ffmpeg has the filter — probed once) → `scale=maxDim:maxDim:force_original_aspect_ratio=decrease` → encode. JPEG targets flatten alpha onto white.
- **Quality ladder:** if the encode exceeds `maxBytes`, retry at quality −5/−10/−15 (lossless formats: single encode).
- **GIF:** animated GIFs flatten to the first frame (noted).
- **Fallback:** if the gate cannot process the file (no ffmpeg / probe failure), raw bytes are returned with a note.
- **Config:** `imageGate.maxDim` (2000), `imageGate.maxBytes` (4718592), `imageGate.jpegQuality` (80).

### Video frames (`src/video.ts`)

- Videos are read as **N evenly spaced JPEG frames** — no native video block.
- **Auto frame count:** ~1 per 5s of duration, clamped to [2, 16]. The `frames` param (1–16) overrides; out-of-range values are clamped with a note.
- Extraction: `ffmpeg -i input -vf fps=N/duration -frames:v N frame-%03d.jpg`.
- Each frame passes through the gate (JPEG).
- **Legend** (text block): frame count + why (auto/requested), duration, dimensions, codec, fps, audio presence (`audio: present — not included` / `audio: none`). Per-frame captions: `Frame i/N @ timestamp`.
- **Size cap bypass:** video decodes N frames, not the whole file (like `info=true`).
- **Failure:** probe or extraction failure → note, no crash.

### Audio (probe-only)

Audio media is no longer loaded. A note points to `info=true` for metadata (format, duration, streams). The `info=true` probe still decodes audio metadata via ffmpeg.

### PPTX pipeline (@s8fy/pptx-converter → PDF → mupdf)

- **Library:** `@s8fy/pptx-converter` (in-process WASM engine).
- **Flow:** `pptxToPdf(buffer)` → PDF Buffer → temp file → `readPdf`.
- **License:** PolyForm-Noncommercial. Free tier adds a demo watermark to PDF output (cosmetic, doesn't affect model comprehension).
- **Cleanup:** temp directory removed in `finally`.

### PDF pipeline (mupdf WASM, in-memory)

- **Library:** `mupdf` npm package (MuPDF C engine in WebAssembly). ESM, zero native deps, AGPL.
- **Text mode** (default): `page.toStructuredText("preserve-whitespace").asText()` per page. Lightweight, works with any model.
- **Image mode**: `page.toPixmap(Matrix.scale(dpi/72, dpi/72), ColorSpace.DeviceRGB)` per page → PNG temp file → **the gate** (JPEG output, bounded). For visual escalation.
- **Pagination:** `pages` param accepts `"1"`, `"1-5"`, `"3,7,12"`. Default: page 1. Response includes total page count so the model can navigate.
- **TOC:** `toc=true` → `doc.loadOutline()` returns hierarchical outline with titles and page refs. Formatted as indented list.
- **Search:** `search='query'` → `page.search(needle)` per page. Returns matching pages with 60-char context windows. Case-insensitive.
- **DPI:** `dpi=N` overrides `config.defaults.pdf.defaultDpi` for image mode. Range 72–600.
- **Region-finding:** see the **Trace** subsection below — `trace={}` overlays numbered guiding lines (0-100 coords); `trace={x,y,w,h}` crops the untraced original.
- **Memory:** mupdf uses WASM memory (not GC'd). All objects (`doc`, `page`, `pixmap`, `stext`) must be `.destroy()`'d in `finally` blocks.
- **Config:** `pdf.defaultDpi` (150), `pdf.maxPagesPerCall` (10).

### Trace (region-finding v2, `src/trace.ts`)

Replaces `zoom`. A tracing mode for zooming: when the model wants to crop a region it can see but not pinpoint, the tool overlays numbered guiding lines so the model can read coordinates directly instead of guessing (avoids repeat zoom calls just to get it right).

- **Scope:** static images only — direct formats, converted formats, PDF image mode, and GIF (as static/first frame). Video frames deferred (time dimension).
- **Two modes:** (1) *trace* (`trace={}`, no coords) — overlay numbered guiding lines, return the numbered image + temp path; (2) *crop* (`trace={x,y,w,h}`) — crop the untraced original at those coords, return the cropped image + temp path.
- **Crop from the untraced original:** the crop always operates on the original untraced image (full resolution, no guiding lines), never the traced overlay or a converted/compressed version.
- **Coordinate space:** local per `path`, fresh each call, **0-100 percent** (two-digit integers, no decimals). Iterative drill-down (crop → re-trace) recovers finer precision.
- **Line density:** auto from the longest side (~1 line per 200px), snapped to a divisor of 100 so labels land on whole numbers; overridable by `trace.lines`.
- **Split for legibility:** if the longest side exceeds `maxDim`, the traced image is cut into two halves (left-right or top-bottom) with continuous numbering, so numbers stay crisp after the gate.
- **Gate only at serialization:** the ffmpeg gate is applied only before the image is serialized; temp files on disk stay full-resolution.
- **Region readout:** the crop echoes back the exact region (0-100 coords + pixel dims + source dims) so "did I get the right region?" is a pure yes/no.
- **Temp lifecycle:** per-session temp dir `extendedread-tmp/<session_id>/media-<n>.png`; the model can pass a temp path back as `path` to re-trace/crop. `/extended-read-clean` deletes the session's temp dir.
- **Fonts:** drawtext labels use the bundled SFNSMono.ttf (macOS); when no font is found, lines are still drawn (labels omitted, noted).

### Metadata probe (`info=true`)

- **Zero deps:** `ffmpeg -hide_banner -i file` prints the stream dump to stderr; parse it for format, duration, bitrate, video codec/dimensions, audio codec/sample rate. No ffprobe binary needed.
- **Word-anchored WxH scan** skips ffmpeg's hex fourcc pointers (`0x31637661`) that false-match a bare digit-x-digit pattern with width 0.
- **Runs before size cap and capability gate:** the probe loads no media, so a file over `maxBytes` or on a text-only model can still be inspected; result is plain text any model can read. Drop `info=true` to load the file itself.
- **PDF/PPTX** get a guidance note (use `toc=true`/`pages`; pass PPTX directly) — ffmpeg cannot decode them.
- The param description tells the model this replaces ad-hoc ffprobe scripts for first looks on large media.

## 7. Wire format & serialization

All media uses the **native mechanism**: the tool returns content blocks in the tool result, pi's `convertMessages` serializes them, **no hook, no marker, no patch**.

The tool emits only `image` and `text` content blocks. pi's OpenAI-compatible provider serializes `image` blocks natively:

| Content block | Serialized as |
|---|---|
| `{ type: "image", data, mimeType }` | `{ type: "image_url", image_url: { url: "data:${mimeType};base64,${data}" } }` |
| `{ type: "text", text }` | `{ type: "text", text }` |

**Consequence for compaction:** because the media is in the conversation (tool result), not hidden in the payload, compaction can see it. No size-estimation patch is needed (image blocks are already accounted for).

## 8. Plugin structure

```
pi-extendedread-plugin/
  src/
    index.ts            — plugin entry: registerTool + activate (load config)
    readExtended.ts     — dispatch spine: modality routing, capability gate, size cap
    config.ts           — loads config.json, exposes model capabilities + knobs
    ffmpeg.ts           — ffmpeg helpers: runFfmpeg, probe, crop, dimension probing
    gate.ts             — the ffmpeg image gate (pass-through / re-encode / JPEG)
    video.ts            — video → evenly spaced JPEG frames
    pdf.ts              — PDF: text extraction, page rendering, TOC, search, trace crop
    pptx.ts             — PPTX → PDF via @s8fy/pptx-converter, delegates to pdf.ts
    trace.ts            — region-finding v2: numbered overlay + crop (0-100 coords), per-session temp
    types.d.ts          — ambient module declarations for pi's dist exports
  config.json           — user-editable (self-documenting, §3)
  test/
    readExtended.test.ts
```

## 9. Context management

- **Laziness:** media is in the context only after the model calls the tool.
- **Compaction interleave:** tool results are compactable; media can be shed and re-read on demand (depends on a future pi compaction feature).
- **Ephemeral across compaction:** accepted; re-read from source is cheap and deterministic.

## 10. Relationship with native `read`

| | Native `read` | `extendedRead` |
|---|---|---|
| Text | yes | no (use native `read`) |
| Images | 5 formats (jpg, png, gif, webp, bmp), magic-byte sniff | 12 formats (adds heic/heif/tiff/tif/tga/avif via ffmpeg), all gated |
| Video | no | yes (as JPEG frames) |
| Audio | no | probe-only (`info=true`) |
| PDF | no | yes (text extraction + visual rendering, pagination) |
| PPTX | no | yes (converts to PDF via @s8fy/pptx-converter) |
| Resize | in-memory (Photon) | ffmpeg gate (bounded dims/bytes) |
| Serialization | pi's `convertMessages` (native) | pi's `convertMessages` (native) |
| Trigger | model calls `read` | model calls `extendedRead` |

**`extendedRead` is a media superset of native `read`.** It handles all image formats the native `read` handles (jpg, png, gif, webp, bmp) **plus** more (heic, heif, tiff, tif, tga, avif), plus video (frames), and PDF. It does **not** handle text — the native `read` continues to handle text.

**Coexist, not replace.** The two tools are complementary:
- `read` → text files (and images, if the model prefers).
- `extendedRead` → media files (images, video, PDF).

The model picks the tool based on file type. There's no conflict: both can handle images, and the model's choice is deterministic (media → `extendedRead`, text → `read`).

## 11. Edge cases

| Case | Handling |
|---|---|
| File not found / not a file / unreadable | clear `isError: true` result with the reason |
| File exceeds `maxBytes` (image) | note + no inline |
| `ffmpeg` conversion/gate fails | raw-bytes fallback (images) or note (video) — no crash |
| Unsupported extension | note naming the extension |
| `~` in path | expanded to `homedir()` |
| `ffmpeg.path` missing | graceful: raw bytes (images) / note (video) |
| Model doesn't support images | note ("Model does not support images") |
| Audio file | note: "audio support removed; probe with info=true" |
| Video: probe/extraction fails | note, no crash |
| Video: `frames` out of range | clamped to 1–16 with a note |
| PDF: page out of range | silently skipped (no error) |
| PDF: empty page selector | defaults to page 1 |
| PDF: page has no text | hint: "[no text on this page — use mode='image' to view]" |
| PDF: pages exceed `maxPagesPerCall` | silently sliced to max |

## 12. Cleanup

- `/tmp` is a **working directory, not persistence** — it's where `ffmpeg` writes output before base64-encoding.
- OS-managed; no ledger to reconcile.
- The media reaches the server as an inline `image_url` part; the `/tmp` file is just the conversion artifact.

## 13. Future work

Ordered by dependency: foundational work first, then what builds on it, then independent additions, then externally-blocked items.

**Foundational**

- **Local omni model (opt-in power mode)** — host a small CPU omni model to give the plugin semantic understanding the main model's vision can't: `LiquidAI/LFM3-Omni-2B-GGUF` (2B, understands text/image/video/audio, answers in text+speech; llama.cpp v0.8.0+, Q4_K_M ~1.3 GB + projectors, non-reasoning). **Hosting:** don't bundle — shell out to a `llama-cli`/`llama-mtmd-cli` binary (external prerequisite, like ffmpeg; `-hf` flag auto-downloads the model + projectors to llama.cpp's cache). Per-call spawn for v1 (simple); a persistent `llama-server` is the later optimization. **Opt-in config only** (`localModel.enabled` etc.) — off by default, matching the "no CV/ML deps by default" constraint. **Use cases, in order:** (1) *audio ASR* — turns the "audio support removed" dead end into a transcript (audio → text block, still patch-free); (2) *video understanding* — it sees frames AND hears the soundtrack, so it can complement the N-frames approach with a semantic summary + audio-track transcript. **Not** for region finding — 2B vision is too weak to read fine text or pinpoint coordinates; trace stays the approach. **Risks:** 2B quality (English ASR best, others weaker; video understanding is "what's happening" level, not fine-detail), first-use ~1.5 GB download + model load, CPU latency on long audio (needs a duration cap or "too long" note).
- **Resize options exposure:** whether to let the model control image resize parameters.

**New format readers (independent of the above)**

- **DOCX support** — use `mammoth` (npm, pure JS) to extract text directly from DOCX. No PDF conversion needed. Handles headings, paragraphs, tables, lists.
- **Pages (`.pages`) support** — macOS-only. Convert to PDF via AppleScript/Pages app, then use existing PDF pipeline.
- **Notebook (`.ipynb`) read** — read a Jupyter notebook as structured content instead of raw JSON: each cell's type + source as markdown, with outputs flagged (truncated by default, opt-in full). Pure JSON parse (`nbformat` v4 structure: `cells[]` with `cell_type`, `source` as a list of line strings, `outputs`, `metadata`), zero new dependencies. Dispatch: `.ipynb` extension → notebook handler in the dispatch spine; read-only, fits extendedRead's read mission. Output: per-cell markdown ("Cell N [code|markdown]" + source, "(K outputs — use outputs=true for full)") so the model can reason about a notebook without the raw-JSON tax. The write/edit side (cell-level addressing, replace/insert/delete/clear-outputs) is deliberately a separate tool — spec lives on the Desktop, not in this plugin.

**Blocked on external work**

- **Compaction interleave:** shedding stale tool-result media depends on a future pi compaction feature.
