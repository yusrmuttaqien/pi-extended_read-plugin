# pi-extendedread-plugin

Pi extension: `extendedRead` tool for media files (images, video, PDF, PPTX) with a bundled-ffmpeg gate.

Media modality is gated by model capabilities in `config.json` — configure per-model image support.

Complements pi's native `read` tool (text) by adding:
- **Images** (png, jpg, jpeg, gif, webp, bmp direct; heic, heif, tiff, tif, tga, avif converted) — every raster is gated: bounded dimensions and bytes, JPEG for derived output
- **Video** (mp4, webm, mkv, mov, avi) — read as evenly spaced JPEG frames (audio omitted, noted)
- **PDF** (text extraction + visual page rendering, with pagination)
- **PPTX** (converts to PDF via @s8fy/pptx-converter, then uses the PDF pipeline)
- **Audio** (wav, mp3, flac, ogg, aiff, aif, m4a, aac, wma, opus) — probe-only: `info=true` metadata, no media load

## How it works

The model calls `extendedRead` with a file path. The tool:
1. Resolves the path (tilde expansion, relative/absolute).
2. Stats the file and enforces the image size cap.
3. Gates on model capability (from `config.json`).
4. Dispatches by extension:
   - **Images:** the ffmpeg gate (below) — direct formats pass through within limits, over-limit direct formats re-encode in their own format, converted formats become JPEG.
   - **Video:** ffmpeg → evenly spaced JPEG frames (each gated).
   - **PDF:** mupdf (WASM) → text extraction, or page rendering → the gate.
   - **PPTX:** @s8fy/pptx-converter → PDF → the PDF pipeline (in-process WASM, no system dependency).
5. Returns content blocks (`image`/`text`) in the tool result.

No patches to pi are required — the tool emits only `image` blocks, which pi serializes natively.

## Image gate

Every raster this tool emits passes through the gate (`src/gate.ts`):

- **Direct formats** (png, jpg, jpeg, gif, webp, bmp) pass through **byte-identical** when within limits. Over-limit direct images are re-encoded **in their own format** (never cross-converted).
- **Derived rasters** (converted formats, video frames, PDF renders, zoom crops) are encoded to **JPEG**.
- The gate enforces `imageGate.maxDim` (default 2000px) and `imageGate.maxBytes` (default 4.5MB base64) via a quality ladder. Animated GIFs flatten to the first frame (noted).
- If the gate cannot process a file (no ffmpeg / probe failure), raw bytes are returned with a note.

| Call | Result |
|---|---|
| `extendedRead path="photo.png"` | Image block (pass-through or re-encoded PNG, gated) |
| `extendedRead path="photo.heic"` | Converted to JPEG via the gate |
| `extendedRead path="photo.png" zoom='{x:0,y:0,w:0.5,h:0.5}'` | Magnify upper-left quadrant |
| `extendedRead path="photo.png" info=true` | Metadata text (size, format, dimensions) — no image loaded |

**`zoom`** — crop + scale a rectangular region. Normalized `[x, y, w, h]` fractions 0–1 of the image. Works on any image format, direct, converted, and PDF image mode.

## Video reading

Videos are read as evenly spaced JPEG frames — no native video block. Frame count auto-scales with duration (~1 per 5s, clamped 2–16); the `frames` param overrides (1–16). Audio is omitted (noted in the legend).

| Call | Result |
|---|---|
| `extendedRead path="video.mp4"` | Auto frames (2–16) as JPEG image blocks |
| `extendedRead path="video.webm" frames=8` | 8 evenly spaced JPEG frames |
| `extendedRead path="video.mkv" info=true` | Metadata text (size, duration, dimensions, audio streams) — no video loaded |

## Audio (probe-only)

Audio media is no longer loaded — a note points to `info=true` for metadata (format, duration, streams).

## PDF reading

Text extraction, visual rendering, table of contents, and text search via mupdf (WASM).

| Call | Result |
|---|---|
| `extendedRead path="doc.pdf"` | Text of page 1 + pagination hint |
| `extendedRead path="doc.pdf" pages="5-10"` | Text of pages 5–10 |
| `extendedRead path="doc.pdf" pages="3,7,12"` | Text of pages 3, 7, and 12 |
| `extendedRead path="doc.pdf" mode="image"` | JPEG of page 1 (gated) |
| `extendedRead path="doc.pdf" mode="image" pages="3,7"` | JPEG of pages 3 and 7 |
| `extendedRead path="doc.pdf" mode="image" dpi=300` | Render at 300 DPI (gated) |
| `extendedRead path="doc.pdf" mode="image" zoom='{x:0,y:0,w:0.5,h:0.5}'` | Magnify upper-left quadrant |
| `extendedRead path="doc.pdf" toc=true` | Table of contents/outline |
| `extendedRead path="doc.pdf" search="quarterly revenue"` | Pages matching query |

- **Text mode** (default): extracts text via mupdf's `toStructuredText`. Lightweight, works with any model.
- **Image mode**: renders pages at configurable DPI (`dpi` param, default 150), then runs each render through the gate (JPEG, bounded). For visual escalation (charts, diagrams, scanned docs).
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

The `$docs` key in the file documents every setting.

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
```

## Spec

Full design: [SPEC.md](https://github.com/yusrmuttaqien/pi-extendedread-plugin/blob/main/SPEC.md)
