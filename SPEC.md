# `extendedRead` — Design Spec

A model-invoked tool that reads media files (images, audio, video, PDF, PPTX) and returns them as attachments the model can perceive. Complements the native `read` tool (text + basic images) by adding audio, video, extended image formats, PDF reading, and PPTX.

## 1. Goal

Provide the model with a dedicated tool for media files. The native `read` tool handles text and a small set of image formats (jpg, png, gif, webp, bmp). `extendedRead` extends this to:

- More image formats (heic, heif, tiff, tif, tga, avif).
- Audio (wav, mp3, flac, ogg, aiff, aif, m4a, aac, wma, opus).
- Video (mp4, webm, mkv, mov, avi).
- **PDF** (text extraction + visual page rendering, with pagination).
- **PPTX** (converts to PDF via @s8fy/pptx-converter, then uses the PDF pipeline).

Media enters the context **lazily** — only when the model calls the tool.

## 2. Design principles

| Principle | Choice |
|---|---|
| Media enters context | Lazily, only on tool call |
| Images | In-memory (no temp file) — reuse pi's Photon/resize pipeline |
| Audio / video | `ffmpeg` → `/tmp` → base64 → content block in tool result |
| Serialization | **Native mechanism** — tool returns content blocks, pi's `convertMessages` serializes. No hook, no marker. |
| Format handling | Deterministic; same support matrix across platforms |
| Cleanup | OS-managed `/tmp`; no bookkeeping |
| Pi patch | Bundled with plugin, applied on load + via `/extended-read-patch` slash command |
| Configuration | User-editable `config.json` with self-documenting `$docs` key |

## 3. Config file

Location: `~/.pi/agent/extensions/pi-extendedread/config.json`

The config is **self-documenting**: a `$docs` key describes every other key and its valid values.

```json
{
  "$docs": {
    "models": {
      "$description": "Map of model_id → model-specific settings. Unknown models fall back to 'defaults'.",
      "input": "Modalities the model can receive. Valid: 'text', 'image', 'audio', 'video'. Controls which media types extendedRead returns. If 'audio' is absent, audio files return a note instead of media.",
      "maxBytes": {
        "$description": "Per-modality size caps (bytes). Larger files return a note.",
        "image": "Default: 10485760 (10 MB).",
        "audio": "Default: 20971520 (20 MB).",
        "video": "Default: 52428800 (50 MB)."
      }
    },
    "defaults": {
      "$description": "Fallback for models not listed in 'models'.",
      "input": "Same as models.input. Default: ['text', 'image'].",
      "maxBytes": "Same as models.maxBytes."},
      "executionMode": "'parallel' (concurrent reads) or 'sequential'. Default: 'parallel'.",
      "ffmpegTimeoutMs": "ffmpeg conversion timeout (ms). Default: 30000."
    }
  },
  "models": {
    "llama-3.2-11b-vision": {
      "input": ["text", "image"]
    },
    "multimodal-av-model": {
      "input": ["text", "image", "audio", "video"],
      "maxBytes": {
        "video": 104857600
      }
    }
  },
  "defaults": {
    "input": ["text", "image"],
    "maxBytes": {
      "image": 10485760,
      "audio": 20971520,
      "video": 52428800
    },
    "executionMode": "parallel",
    "ffmpegTimeoutMs": 30000
  }
}
```

**Capability gating:** the tool checks `config.models[modelId].input` (or `defaults.input`) before returning media blocks. If the model doesn't list `"audio"`, an audio file returns a text note (`"Model does not support audio"`) instead of an `audio` block. This replaces pi's `model.input.includes("image")` gate with a user-configurable equivalent.

## 4. Tool definition

Registered via `pi.registerTool(...)` (see `dist/core/extensions/types.d.ts`, `ToolDefinition`).

```ts
defineTool({
  name: "extendedRead",
  label: "Extended Read",
  description:
    "Read a media file and return it as an attachment the model can perceive. " +
    "Images: png, jpg, jpeg, gif, webp, bmp, heic, heif, tiff, tif, tga, avif. " +
    "Audio: wav, mp3, flac, ogg, aiff, aif, m4a, aac, wma, opus. " +
    "Video: mp4, webm, mkv, mov, avi. " +
    "PDF: text extraction (default) or page rendering to image. Use pages='1-5' for pagination, toc=true for outline, search='query' to find text, dpi=N for resolution, zoom='{x,y,w,h}' to crop+scale a rectangular region on any image — direct or converted formats and PDF image mode. " +
    "PPTX: converts to PDF via @s8fy/pptx-converter, then uses the PDF pipeline. " +
    "For text files, use the native read tool.",
  promptSnippet: "Read media files",
  promptGuidelines: [
    "Use extendedRead to read media files (images, audio, video, PDF) the user references.",
    "Use the native read tool for text files.",
  ],
  parameters: Type.Object({
    path: Type.String({ description: "Path to the file (relative, absolute, or ~)" }),
    pages: Type.Optional(Type.String({ description: "Page selector for PDFs: '1', '1-5', '3,7,12' (default: '1')" })),
    mode: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("image")], { description: "PDF mode: 'text' (default) or 'image'" })),
    toc: Type.Optional(Type.Boolean({ description: "PDF: return table of contents/outline" })),
    search: Type.Optional(Type.String({ description: "PDF: search for text (case-insensitive), returns matching pages with context" })),
    dpi: Type.Optional(Type.Number({ description: "PDF: DPI for image mode (72-600, default from config)" })),
    zoom: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number(), w: Type.Number(), h: Type.Number() }, { description: "Crop + scale a rectangular region on any image — direct formats (png,jpg,gif,webp,bmp), converted formats (heic,tiff,tif,avif,...) and PDF image mode. Normalized [x,y,w,h] fractions 0–1 of the bounding box; omit for full frame." })),
    info: Type.Optional(Type.Boolean({ description: "Metadata-only first look on ffmpeg-decodable media (image/audio/video): size, duration, dimensions, video codec, audio streams. No media loaded; use before deciding how to load a large file. No ad-hoc ffprobe script needed." })),
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

  // 2b. Info probe: metadata-only first look for ffmpeg-decodable media.
  // Runs before the size cap and capability gate so a large file can be
  // inspected before deciding how to load it; result is plain text.
  if (params.info) {
    const m = modalityOf(ext);
    return m ? ok(renderProbeText(await probeMedia(path), stat.size, ext))
             : note(`info works on image/audio/video; for PDF use toc=true/pages`);
  }

  // 3. Size cap (per-modality)
  const modality = modalityOf(ext); // "image" | "audio" | "video" | undefined
  if (modality && stat.size > maxBytes[modality])
    return note(`File too large (${stat.size} > ${maxBytes[modality]} bytes for ${modality})`);

  // 4. Capability gate
  const input = modelInput(ctx.modelId); // from config
  const ext = extname(path).toLowerCase().slice(1);

  // 5. Dispatch
  if (IMAGE_DIRECT[ext]) {
    if (!input.includes("image")) return note("Model does not support images");
    const bytes = await fs.readFile(path);
    // zoom: crop region → processImageBytes(cropped)
    const { data, mimeType } = await processImage(bytes, MIME[ext]);
    return ok([txt(`Read image [${mimeType}]`), img(data, mimeType)]);
  }
  if (IMAGE_CONVERT[ext]) {
    if (!input.includes("image")) return note("Model does not support images");
    const tmp = await ffmpegConvert(path, "png");
    const bytes = await fs.readFile(tmp); rm(tmp);
    // zoom: same crop routing as direct (on the converted raster)
    const { data, mimeType } = await processImage(bytes, "image/png");
    return ok([txt(`Read image [${mimeType}]`), img(data, mimeType)]);
  }
  if (AUDIO_DIRECT[ext]) {
    if (!input.includes("audio")) return note("Model does not support audio");
    const b64 = (await fs.readFile(path)).toString("base64");
    return ok([txt(`Read audio [${MIME[ext]}]`), aud(b64, MIME[ext])]);
  }
  if (AUDIO_CONVERT[ext]) {
    if (!input.includes("audio")) return note("Model does not support audio");
    const tmp = await ffmpegConvert(path, "mp3");
    const b64 = (await fs.readFile(tmp)).toString("base64"); rm(tmp);
    return ok([txt("Read audio [audio/mpeg]"), aud(b64, "audio/mpeg")]);
  }
  // ... video direct/convertible (same pattern) ...

  // --- PDF ---
  if (ext === "pdf") {
    return readPdf(path, params, config);
  }

  // --- PPTX (convert to PDF via @s8fy/pptx-converter) ---
  if (ext === "pptx") {
    return readPptx(path, params, config);
  }

  return note(`[extendedRead: unsupported format ${ext}]`);
}
```

Mirrors native `read`'s flow: resolve → stat → detect → process → return. Difference: extension-based dispatch (vs. magic bytes), capability gating, and media branches.

## 6. Media handling

### Format support matrix

| Modality | Direct (no conversion) | Converted via `ffmpeg` → target |
|---|---|---|
| Image | png, jpg, jpeg, gif, webp, bmp | heic, heif, tiff, tif, tga, avif → **png** |
| Audio | wav, mp3, flac, ogg, aiff, aif | m4a, aac, wma, opus → **mp3** |
| Video | mp4 | webm, mkv, mov, avi → **mp4** |
| PPTX | — | pptx → **pdf** (via @s8fy/pptx-converter) |

### Image pipeline (in-memory, no `/tmp`, resize)
- Reuse pi's `processImage(bytes, mimeType, { autoResizeImages: true, resizeOptions })` (`dist/utils/image-process.js`).
- Normalizes via **Photon** (WASM, in-process) and resizes in a worker thread.
- Returns `{ data: base64, mimeType }`. No disk write, nothing to clean up.
- **Resize is image-only.** Video/audio are not resized — they pass through ffmpeg as-is.

### Audio / video pipeline (`/tmp`, no resize)
- Run bundled `ffmpeg` (`@ffmpeg-installer/ffmpeg` → `ffmpeg.path`) with `execFile(ffmpeg.path, ["-y", "-i", in, out], { timeout: ffmpegTimeoutMs })`.
- Output to `os.tmpdir()` as `pi-media-<pid>-<uuid>.<ext>`.
- base64-encode the temp file bytes.
- **Cleanup:** OS-managed. No ledger.

### PPTX pipeline (@s8fy/pptx-converter → PDF → mupdf)
- **Library:** `@s8fy/pptx-converter` (in-process WASM engine).
- **Flow:** `pptxToPdf(buffer)` → PDF Buffer → temp file → `readPdf`.
- **License:** PolyForm-Noncommercial. Free tier adds a demo watermark to PDF output (cosmetic, doesn't affect model comprehension).
- **Cleanup:** temp directory removed in `finally`.

### PDF pipeline (mupdf WASM, in-memory)
- **Library:** `mupdf` npm package (MuPDF C engine in WebAssembly). ESM, zero native deps, AGPL.
- **Text mode** (default): `page.toStructuredText("preserve-whitespace").asText()` per page. Lightweight, works with any model.
- **Image mode**: `page.toPixmap(Matrix.scale(dpi/72, dpi/72), ColorSpace.DeviceRGB).asPNG()` per page. For visual escalation.
- **Pagination:** `pages` param accepts `"1"`, `"1-5"`, `"3,7,12"`. Default: page 1. Response includes total page count so the model can navigate.
- **TOC:** `toc=true` → `doc.loadOutline()` returns hierarchical outline with titles and page refs. Formatted as indented list.
- **Search:** `search='query'` → `page.search(needle)` per page. Returns matching pages with 60-char context windows. Case-insensitive.
- **DPI:** `dpi=N` overrides `config.defaults.pdf.defaultDpi` for image mode. Range 72–600.
- **Region zoom (`zoom`):** crop + scale a rectangular region on any image (text has no pixels to enlarge). Param `{x,y,w,h}` are normalized fractions in [0,1] of the page/image bounding box — resolution-independent so the model needs no pixel/DPI math. Applies to every image path: direct formats, converted formats, and PDF image mode:
  - **Direct image:** crop the source file at `frac × originalPixelDims`, then pass through pi's pipeline (Photon) which final-sizes it under the inline budget.
  - **Converted image:** ffmpeg first converts heic/tiff/avif/etc. to PNG, then crop that raster at `frac × rasterDims` with ffmpeg before passing through pi's pipeline — identical handling to the direct-image path.
  - **PDF image mode:** mupdf renders the page via `toPixmap`; the rendered PNG (and any ffmpeg zoom crop of it) then goes through pi's Photon/resize pipeline so every image this tool returns is bounded (raw-PNG fallback on pipeline failure).
  - **Reference frame:** fractions are relative to the full raster already shown in image mode; no new coordinate metadata is needed. Ordering: for a PDF the model must render the full page (`mode="image"`) first to obtain a frame it can crop from, then request fractional boxes — inherent and not extra work.
  - **Default:** omit `zoom` → full frame, byte-identical to today (backward compatible). Crop is done with ffmpeg's `crop=w:h:x:y`; small crops are upscaled by pi toward the budget. Targeting is approximate (eyeballed fractions), which is acceptable for "get that region bigger" and not pixel-perfect.
- **Memory:** mupdf uses WASM memory (not GC'd). All objects (`doc`, `page`, `pixmap`, `stext`) must be `.destroy()`'d in `finally` blocks.
- **Config:** `pdf.defaultDpi` (150), `pdf.maxPagesPerCall` (10).

### Metadata probe (`info=true`)

- **Zero deps:** `ffmpeg -hide_banner -i file` prints the stream dump to stderr; parse it for format, duration, bitrate, video codec/dimensions, audio codec/sample rate. No ffprobe binary needed.
- **Word-anchored WxH scan** skips ffmpeg's hex fourcc pointers (`0x31637661`) that false-match a bare digit-x-digit pattern with width 0.
- **Runs before size cap and capability gate:** the probe loads no media, so a file over `maxBytes` or on a text-only model can still be inspected; result is plain text any model can read. Drop `info=true` to load the file itself.
- **PDF/PPTX** get a guidance note (use `toc=true`/`pages`; pass PPTX directly) — ffmpeg cannot decode them.
- The param description tells the model this replaces ad-hoc ffprobe scripts for first looks on large media.

## 7. Wire format & serialization

All media uses the **native mechanism**: the tool returns content blocks in the tool result, pi's `convertMessages` serializes them, **no hook, no marker**. This mirrors the native `read` tool's image path exactly.

pi's OpenAI-compatible provider currently serializes **only `image` content blocks** → `image_url` parts. It does **not** serialize audio/video content blocks.

**The patch** (see §8) extends `convertMessages` to serialize `audio` and `video` content blocks the same way it serializes `image` blocks:

| Content block | Serialized as |
|---|---|
| `{ type: "image", data, mimeType }` | `{ type: "image_url", image_url: { url: "data:${mimeType};base64,${data}" } }` |
| `{ type: "audio", data, mimeType }` | `{ type: "input_audio", input_audio: { data, format: mimeType } }` |
| `{ type: "video", data, mimeType }` | `{ type: "input_video", input_video: { data, format: mimeType } }` |

The patched `convertMessages` extracts these blocks from tool results and pushes them as a separate user message (same pattern as the existing image path). No hook, no marker, no payload rewrite.

**Consequence for compaction:** because the media is in the conversation (tool result), not hidden in the payload, compaction can see it. The patch also extends compaction's size estimation to account for `audio` and `video` blocks (see §8).

## 8. Pi patch

The native mechanism for audio/video requires a patch to pi's provider bundle, compaction, and type declarations. The patch is **bundled with the plugin**, versioned with it, and applied automatically.

### Patch targets

| ID | File | Change |
|---|---|---|
| `convertMessages` | `dist/bundle/chunks/openai-completions-*.js` | Add `audio`/`video` to `hasImages` detection |
| `convertMessagesBlocks` | `dist/bundle/chunks/openai-completions-*.js` | Map `audio`/`video` blocks to `input_audio`/`input_video` serialization |
| `compaction` | `dist/core/compaction/compaction.js` | Add `ESTIMATED_AUDIO_CHARS`, `ESTIMATED_VIDEO_CHARS`; extend size walk |

### How it's applied

- **Automatic on plugin load.** The plugin's activation checks for a sentinel comment (`// pi-extendedread:v1:<targetId>`) in each target file. If absent, it reads the file, applies the string replacement, writes it back, and inserts the sentinel. Idempotent. Legacy sentinels (`// pi-media-patch:v1:<targetId>`) are also recognized for backward compatibility.
- **Slash command** (`/extended-read-patch`). Forces re-apply. Reports per-target: "patched", "already present", or "target not found (pi update?)".

### Locating files

- Bundle: `require.resolve("@earendil-works/pi-coding-agent/package.json")` → `dist/bundle/chunks/` → glob `openai-completions-*.js`.
- Compaction: same root → `dist/core/compaction/compaction.js`.
- Types: same root → `dist/core/extensions/types.d.ts`.

### Versioning, failure & maintenance

- Sentinel: `// pi-extendedread:v1:<targetId>`. Legacy: `// pi-media-patch:v1:<targetId>` (still recognized). Version mismatch → re-apply.
- **Pi version recorded:** the plugin reads the pi version from `@earendil-works/pi-coding-agent/package.json` and stores it alongside the sentinel. `/extended-read-patch` reports: `"patched against pi v0.4.2"`.
- If a target's anchor string doesn't match (pi structural change), the plugin warns: `"pi-extendedread: target '<id>' not found — pi update may have changed the code. Manual review needed."` Loud, not silent.
- **Maintenance:** when pi updates and a target fails, read the new bundle, update the anchor + replace in `targets.ts`, bump the sentinel version, re-apply via `/extended-read-patch`. `PATCHES.md` is the checklist.

## 9. Plugin structure

```
pi-extendedread-plugin/
  src/
    index.ts            — plugin entry: registerTool + activate (apply patches, load config)
    readExtended.ts     — dispatch spine: modality routing, capability gate, size cap
    config.ts           — loads config.json, exposes model capabilities + knobs
    ffmpeg.ts           — ffmpeg helpers: convert, crop, dimension probing
    image.ts            — processImageBytes (wraps pi's Photon pipeline)
    pdf.ts              — PDF: text extraction, page rendering, TOC, search, zoom
    pptx.ts             — PPTX → PDF via @s8fy/pptx-converter, delegates to pdf.ts
    types.d.ts          — ambient module declarations for pi's dist exports
    patch/
      index.ts          — locate files, apply all targets, register /extended-read-patch
      targets.ts        — PatchTarget definitions (anchor, replace, sentinel)
  config.json           — user-editable (self-documenting, §3)
  PATCHES.md            — maintenance doc: table of targets, anchors, sentinels
  test/
    readExtended.test.ts
    patch.test.ts
```

### Self-documenting conventions

- Every source file starts with a block comment: purpose, pi version targeted, verification steps.
- Each `PatchTarget` includes the **exact anchor string** in a comment, so when pi changes, you diff the anchor against the new bundle.
- `PATCHES.md`: one table row per target — ID, file, what it does, anchor (first 40 chars), sentinel. Your maintenance checklist after pi updates.
- `/extended-read-patch` output is the diagnostic: per-target status + the anchor that failed (if any).

## 10. Context management

- **Laziness:** media is in the context only after the model calls the tool.
- **Compaction interleave:** tool results are compactable; media can be shed and re-read on demand (depends on a future pi compaction feature).
- **Ephemeral across compaction:** accepted; re-read from source is cheap and deterministic.

## 11. Relationship with native `read`

| | Native `read` | `extendedRead` |
|---|---|---|
| Text | yes | no (use native `read`) |
| Images | 5 formats (jpg, png, gif, webp, bmp), magic-byte sniff | 12 formats (adds heic/heif/tiff/tif/tga/avif via ffmpeg) |
| Audio | no | yes |
| Video | no | yes |
| PDF | no | yes (text extraction + visual rendering, pagination) |
| PPTX | no | yes (converts to PDF via @s8fy/pptx-converter) |
| Resize | in-memory (Photon) | in-memory (reuse Photon) |
| Serialization | pi's `convertMessages` (native) | pi's `convertMessages` (patched) |
| Trigger | model calls `read` | model calls `extendedRead` |

**`extendedRead` is a media superset of native `read`.** It handles all image formats the native `read` handles (jpg, png, gif, webp, bmp) **plus** more (heic, heif, tiff, tif, tga, avif), plus audio, video, and PDF. It does **not** handle text — the native `read` continues to handle text.

**Coexist, not replace.** The two tools are complementary:
- `read` → text files (and images, if the model prefers).
- `extendedRead` → media files (images, audio, video, PDF).

The model picks the tool based on file type. There's no conflict: both can handle images, and the model's choice is deterministic (media → `extendedRead`, text → `read`).

## 12. Edge cases

| Case | Handling |
|---|---|
| File not found / not a file / unreadable | clear `isError: true` result with the reason |
| File exceeds `maxBytes` (per-modality) | note + no inline |
| `ffmpeg` conversion fails | note + no inline (no crash) |
| Unsupported extension | note naming the extension |
| `~` in path | expanded to `homedir()` |
| `ffmpeg.path` missing | graceful: no conversion, note |
| Model doesn't support modality | note ("Model does not support audio") |
| PDF: page out of range | silently skipped (no error) |
| PDF: empty page selector | defaults to page 1 |
| PDF: page has no text | hint: "[no text on this page — use mode='image' to view]" |
| PDF: pages exceed `maxPagesPerCall` | silently sliced to max |

## 13. Cleanup

- `/tmp` is a **working directory, not persistence** — it's where `ffmpeg` writes output before base64-encoding.
- OS-managed; no ledger to reconcile.
- The media reaches the server as an inline `image_url`/`input_audio`/`input_video` part; the `/tmp` file is just the conversion artifact.

## 14. Future work

Ordered by dependency: foundational work first, then what builds on it, then independent additions, then externally-blocked items.

**Foundational**

- **Patch eviction (audio out, video as frames, ffmpeg gate)** — remove the pi patches entirely: the patch engine (`src/patch/`), the `/extended-read-patch` slash command, and all 3 targets. Goal: the tool emits only `image` content blocks, which pi's `convertMessages` serializes natively, so no patch is needed. Four interdependent changes:
  1. **Audio removed** — delete `AUDIO_DIRECT`/`AUDIO_CONVERT` maps + both dispatch branches; drop `"audio"` from `modalityOf`, `MaxBytes`, and the `input` modalities. Audio files return an "audio support removed" note; `info=true` probe still works (ffmpeg decodes them). Frees the `input_audio` serialization patch target.
  2. **Video as frames** — delete `VIDEO_DIRECT`/`VIDEO_CONVERT` + both dispatch branches; no more `video` content blocks. Video is always read as N evenly-spaced frames via pure ffmpeg (`-vf fps=N/duration -frames:v N`), zero new dependencies. **Frame count auto-adjusts to duration:** shorter videos sample denser, longer videos sparser, with a floor so long videos never get too sparse to be useful and a cap so short videos don't explode. A `frames` param lets the model override the auto count. Output: a legend text block (duration, dimensions, fps, codec, how many frames were sampled and why) that notifies the model of the sampling, + per-frame captions ("Frame i/N @ timestamp"). Frames are JPEG (non-native modality) through the ffmpeg gate. Video bypasses the size cap (decodes N frames, not the whole file, like `info=true`). Frees the `input_video` serialization patch target. **Deferred:** `start`/`end` time-range params for a narrower re-read. The audio omission is noted in both the `info=true` output and the param-less video (frames) output, so the model knows audio is not included.
  3. **ffmpeg gate replaces Photon** — all image attachments (direct images, converted images, video frames, PDF image mode) go through bundled ffmpeg instead of pi's Photon pipeline (`src/image.ts` deleted). Pipeline: `autorotate` (EXIF orientation, matching Photon) → `scale=2000:2000:force_original_aspect_ratio=decrease` → encode → quality ladder (80→75→70→65) if the output exceeds the byte cap. Constants mirror pi's Photon defaults (maxWidth/maxHeight 2000, maxBytes 4.5 MB base64, jpegQuality 80) and are **exposed in config.json** so users can tune them. A direct format already within the limits (dims ≤ 2000, bytes ≤ cap) **passes through as-is** (no ffmpeg); only over-limit direct formats are resized + re-encoded in their own format (not JPEG).
  4. **JPEG standardization** — natively supported image types (png, jpg, jpeg, gif, webp, bmp) stay **direct** (no conversion, including animated GIFs); only non-native formats (heic, heif, tiff, tif, tga, avif) and other modalities (video frames, PDF image mode) convert to JPEG. A source that is already PNG stays PNG (lossless, preserves screenshot/text fidelity). PNG-with-alpha flattened to JPEG gets `-background_color white`. Frees the compaction `ESTIMATED_AUDIO_CHARS`/`ESTIMATED_VIDEO_CHARS` patch target (no audio/video blocks left to estimate).
  Result: only `image` blocks remain → pi serializes them natively → all 3 patch targets dead → `src/patch/` deleted and `/extended-read-patch` removed. The plugin becomes patch-free.

**Built on patch-eviction**

- **Trace (region-finding v2, replaces `zoom`/`grid`/`locate`)** — a tracing mode for zooming: when the model wants to crop a region it can see but not pinpoint, the tool overlays numbered guiding lines on the image so the model can read coordinates directly instead of guessing (avoids repeat zoom calls just to get it right). **Purge `grid` + `locate` first** (on a new branch) before implementing trace. Design:
  - **Scope (v1):** static images only — direct formats, converted formats, PDF image mode, and GIF (as static/first frame; animation dropped). Video frames deferred (time dimension).
  - **Two modes:** (1) *trace* (no coords) — overlay numbered guiding lines, return the numbered image + temp path; (2) *crop* (with coords) — crop at those coords, return the cropped image + new temp path. Trace subsumes `zoom` (crop), `grid`, and `locate` (finding).
  - **Crop from the untraced original:** the crop always operates on the original untraced image (full resolution, no guiding lines/numbers), never the traced overlay version or a converted/compressed version.
  - **Coordinate space:** local per `path`, fresh each call, **0-100 percent** range. If a too-long/wide image is split into halves to keep numbers legible, the numbering is shared/continuous across the split halves.
  - **Coordinate range:** 0-100 (percent) — two-digit integers, no decimals on the lines, most readable for the vision model. 1% resolution is adequate; iterative drill-down (crop → re-trace) recovers finer precision.
  - **Line density:** auto based on image dimensions, overridable by a `lines` param.
  - **Split for legibility:** if the image is too long/wide, split into two evenly-cut halves with continuous numbering, so the numbers stay crisp after the image gate (the gate degrades quality worst at large dimensions).
  - **Gate only at serialization:** the ffmpeg gate (replacing Photon) is applied only before the image is serialized to the LLM; temp files on disk stay full-resolution.
  - **Result:** cropped image block + the temp file path (ffmpeg always produces a temp file).
  - **Temp reuse:** the model can reuse a temp file for further zooms — pass it as `path` to lay guiding lines again, repeating the cycle until satisfied.
  - **Coordinate param:** accepts continuous values between the guiding lines (the lines only accelerate finding the closest number to the target).
  - **Region readout:** echo back the exact region produced (normalized + pixel dims) so "did I get the right region?" is a pure yes/no.
  - **Temp lifecycle:** per-session temp dir `extendedread-tmp/<session_id>/media-<n>.<ext>` (session id in the folder); a `/extended-read-clean` slash command deletes session folders whose session no longer exists.
  - **Open risk:** number legibility is the make-or-break — vision models read "pick the box" (grid/locate) more reliably than "read a number off a line"; the split-into-halves is the mitigation, but legibility must be validated on real downscaled images before fully retiring the pick-based approach.
- **Local omni model (opt-in power mode)** — host a small CPU omni model to give the plugin semantic understanding the main model's vision can't: `LiquidAI/LFM3-Omni-2B-GGUF` (2B, understands text/image/video/audio, answers in text+speech; llama.cpp v0.8.0+, Q4_K_M ~1.3 GB + projectors, non-reasoning). **Hosting:** don't bundle — shell out to a `llama-cli`/`llama-mtmd-cli` binary (external prerequisite, like ffmpeg; `-hf` flag auto-downloads the model + projectors to llama.cpp's cache). Per-call spawn for v1 (simple); a persistent `llama-server` is the later optimization. **Opt-in config only** (`localModel.enabled` etc.) — off by default, matching the "no CV/ML deps by default" constraint. **Use cases, in order:** (1) *audio ASR* — turns patch-eviction's "audio support removed" dead end into a transcript (audio → text block, still patch-free); (2) *video understanding* — it sees frames AND hears the soundtrack, so it can complement the N-frames approach with a semantic summary + audio-track transcript. **Not** for region finding — 2B vision is too weak to read fine text or pinpoint coordinates; trace stays the approach. **Risks:** 2B quality (English ASR best, others weaker; video understanding is "what's happening" level, not fine-detail), first-use ~1.5 GB download + model load, CPU latency on long audio (needs a duration cap or "too long" note).
- **Resize options exposure:** whether to let the model control image resize parameters.

**New format readers (independent of the above)**

- **DOCX support** — use `mammoth` (npm, pure JS) to extract text directly from DOCX. No PDF conversion needed. Handles headings, paragraphs, tables, lists.
- **Pages (`.pages`) support** — macOS-only. Convert to PDF via AppleScript/Pages app, then use existing PDF pipeline.
- **Notebook (`.ipynb`) read** — read a Jupyter notebook as structured content instead of raw JSON: each cell's type + source as markdown, with outputs flagged (truncated by default, opt-in full). Pure JSON parse (`nbformat` v4 structure: `cells[]` with `cell_type`, `source` as a list of line strings, `outputs`, `metadata`), zero new dependencies. Dispatch: `.ipynb` extension → notebook handler in the dispatch spine; read-only, fits extendedRead's read mission. Output: per-cell markdown ("Cell N [code|markdown]" + source, "(K outputs — use outputs=true for full)") so the model can reason about a notebook without the raw-JSON tax. The write/edit side (cell-level addressing, replace/insert/delete/clear-outputs) is deliberately a separate tool — spec lives on the Desktop, not in this plugin.

**Blocked on external work**

- **Compaction interleave:** shedding stale tool-result media depends on a future pi compaction feature.
