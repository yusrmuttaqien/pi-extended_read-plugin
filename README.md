# pi-extendedread-plugin

Pi extension: `extendedRead` tool for media files (images, audio, video, PDF, PPTX) with native serialization.

Media modality is gated by model capabilities in `config.json` — configure per-model support for images, audio, and video.

Complements pi's native `read` tool (text + basic images) by adding:
- Extended image formats (heic, heif, tiff, tif, tga, avif)
- Audio (wav, mp3, flac, ogg, aiff, aif, m4a, aac, wma, opus)
- Video (mp4, webm, mkv, mov, avi)
- **PDF** (text extraction + visual page rendering, with pagination)
- **PPTX** (converts to PDF via @s8fy/pptx-converter, then uses the PDF pipeline)

## How it works

The model calls `extendedRead` with a file path. The tool:
1. Resolves the path (tilde expansion, relative/absolute).
2. Stats the file and enforces a per-modality size cap.
3. Gates on model capability (from `config.json`).
4. Dispatches by extension:
   - **Images:** in-memory via pi's Photon/resize pipeline (no temp file).
   - **Audio/Video:** ffmpeg → `/tmp` → base64 (converted to png/mp3/mp4 if needed).
   - **PDF:** mupdf (WASM) → text extraction, or page rendering to PNG → pi's Photon/resize pipeline.
   - **PPTX:** @s8fy/pptx-converter → PDF → mupdf pipeline (in-process WASM, no system dependency).
5. Returns content blocks (`image`/`audio`/`video`/`text`) in the tool result.

pi's `convertMessages` serializes these blocks into the provider payload (`image_url`/`input_audio`/`input_video`). This requires a **patch** to pi's provider bundle and compaction — applied automatically on plugin load.

## Image reading

Direct formats (png, jpg, jpeg, gif, webp, bmp) are read in-memory. Converted formats (heic, heif, tiff, tif, tga, avif) are decoded via ffmpeg to PNG first.

| Call | Result |
|---|---|
| `extendedRead path="photo.png"` | Full image (direct format) |
| `extendedRead path="photo.heic"` | Converted to PNG via ffmpeg |
| `extendedRead path="photo.png" zoom='{x:0,y:0,w:0.5,h:0.5}'` | Magnify upper-left quadrant |
| `extendedRead path="photo.png" info=true` | Metadata text (size, format, dimensions) — no image loaded |

**Region tools** (work on any image format, direct, converted, and PDF image mode):

- **`zoom`** — crop + scale a rectangular region. Normalized `[x, y, w, h]` fractions 0–1 of the image.

## Video reading

Direct format (mp4) is read as-is. Converted formats (webm, mkv, mov, avi) are transcoded to MP4 via ffmpeg.

| Call | Result |
|---|---|
| `extendedRead path="video.mp4"` | Full video (direct format) |
| `extendedRead path="video.webm"` | Converted to MP4 via ffmpeg |
| `extendedRead path="video.mkv"` | Converted to MP4 via ffmpeg |
| `extendedRead path="video.mp4" info=true` | Metadata text (size, duration, dimensions, audio streams) — no video loaded |

**First look on large media:** `info=true` returns size, format, duration, video codec/dimensions and audio presence as plain text. Use it to decide how to load a big file; drop `info=true` for the file itself.

## PDF reading

Text extraction, visual rendering, table of contents, and text search via mupdf (WASM).

| Call | Result |
|---|---|
| `extendedRead path="doc.pdf"` | Text of page 1 + pagination hint |
| `extendedRead path="doc.pdf" pages="5-10"` | Text of pages 5–10 |
| `extendedRead path="doc.pdf" pages="3,7,12"` | Text of pages 3, 7, and 12 |
| `extendedRead path="doc.pdf" mode="image"` | PNG of page 1 |
| `extendedRead path="doc.pdf" mode="image" pages="3,7"` | PNG of pages 3 and 7 |
| `extendedRead path="doc.pdf" mode="image" dpi=300` | PNG at 300 DPI |
| `extendedRead path="doc.pdf" mode="image" zoom='{x:0,y:0,w:0.5,h:0.5}'` | Magnify upper-left quadrant |
| `extendedRead path="doc.pdf" toc=true` | Table of contents/outline |
| `extendedRead path="doc.pdf" search="quarterly revenue"` | Pages matching query |

- **Text mode** (default): extracts text via mupdf's `toStructuredText`. Lightweight, works with any model.
- **Image mode**: renders pages to PNG at configurable DPI (`dpi` param, default 150), then runs each PNG through pi's Photon/resize pipeline so every image this tool returns is bounded (raw-PNG fallback on pipeline failure). For visual escalation (charts, diagrams, scanned docs).
- **TOC**: `toc=true` extracts the PDF outline/TOC via `doc.loadOutline()`. Returns hierarchical list with titles and page refs.
- **Search**: `search='query'` performs case-insensitive text search via `page.search()`. Returns matching pages with 60-char context windows.
- **Pagination**: the `pages` parameter accepts `"1"`, `"1-5"`, `"3,7,12"`. Default is page 1. The response includes total page count so the model can navigate.

## Metadata probe (`info=true`)

Works on image/audio/video (ffmpeg-decodable). Runs `ffmpeg -i` and parses the stream dump — no media loaded, no ad-hoc ffprobe script needed:

| Call | Result |
|---|---|
| `extendedRead path="video.mp4" info=true` | size, format, duration, video codec + WxH, audio streams |
| `extendedRead path="photo.heic" info=true` | size, format, dimensions |

Runs before the size cap and capability gate: a file over `maxBytes`, or on a text-only model, can still be inspected. PDF/PPTX get a guidance note (use `toc=true`/`pages`; pass PPTX directly).

## Install

```bash
pi install git:https://github.com/yusrmuttaqien/pi-extendedread-plugin
```

### PPTX support

PPTX files are converted to PDF using `@s8fy/pptx-converter` (in-process WASM engine). No system dependency required.

**Note:** The free (unlicensed) tier adds a demo watermark to PDF output. This is cosmetic and does not affect text extraction or model comprehension.

## Configuration

Config is generated to `~/.pi/agent/extensions/pi-extendedread/config.json` on first run. Edit that file to customize:

```json
{
  "models": {
    "my-av-model": {
      "input": ["text", "image", "audio", "video"],
      "maxBytes": { "video": 104857600 }
    }
  },
  "defaults": {
    "input": ["text", "image"],
    "maxBytes": { "image": 10485760, "audio": 20971520, "video": 52428800 },
    "executionMode": "parallel",
    "ffmpegTimeoutMs": 30000,
    "pdf": {
      "defaultDpi": 150,
      "maxPagesPerCall": 10
    }
  }
}
```

The `$docs` key in the file documents every setting.

## Pi patches

The plugin patches three targets in pi's install:

| Target | File | Change |
|---|---|---|
| `convertMessages` | `dist/bundle/chunks/openai-completions-*.js` | Add `audio`/`video` to block detection |
| `convertMessagesBlocks` | `dist/bundle/chunks/openai-completions-*.js` | Map `audio`/`video` blocks to `input_audio`/`input_video` |
| `compaction` | `dist/core/compaction/compaction.js` | Size estimation for audio/video |

Patches are idempotent (sentinel-checked) and versioned. After a pi update, run `/extended-read-patch` to re-apply. See `PATCHES.md` for the maintenance checklist.

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
```

## Spec

Full design: [SPEC.md](https://github.com/yusrmuttaqien/pi-extendedread-plugin/blob/main/SPEC.md)
