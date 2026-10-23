# AGENTS.md — working conventions for pi-extendedread-plugin

Every change has a model-facing surface (what the tool advertises to the LLM), a user/repo-facing surface (README, SPEC, config), and code. Keep all in sync; this file is the update matrix.

## Layout (one job per file)

```
src/index.ts        registerTool: promptSnippet, description, promptGuidelines, TypeBox parameters
src/readExtended.ts dispatch spine + format maps (IMAGE_DIRECT/CONVERT, AUDIO_*, VIDEO_*)
src/config.ts       config.json types + defaults; userConfigPath()
src/ffmpeg.ts       ffmpeg helpers: convert, crop, dims, probe (parseFfmpegProbe/probeMedia/renderProbeText), ZOOM_UNAVAILABLE_HINT
src/image.ts        processImageBytes (wraps pi's Photon pipeline)
src/region.ts       grid + locate math, renderTiles, validateTileParams, GRID_MAX_CELLS
src/pdf.ts          PDF text/pages/toc/search/image mode (+grid/locate on first page); PdfParams carries all params
src/pptx.ts         PPTX → PDF via @s8fy/pptx-converter, delegates to pdf.ts
src/patch/targets.ts  patch anchors; src/patch/index.ts applies them + /extended-read-patch
test/readExtended.test.ts  unit tests (pure parsers, tile math, routing)
```

Dependency DAG: `ffmpeg → image → region → pdf → pptx → readExtended`. No cycles. New code goes into the module that owns its job; a new concern gets its own file and an entry in SPEC §9.

## Update matrix — change type ⇒ files to touch

| Change | Must update |
| --- | --- |
| Tool param added/renamed | `src/index.ts` schema + the param's description text; README per-modality tables (`Image reading`, `Video reading`, `PDF reading`) + Metadata probe section when relevant; SPEC §4 tool-definition table; tests. |
| Tool param semantics changed | owning module (`readExtended.ts` or the format handler); SPEC §5 dispatch steps; README row for that param; routing tests. |
| Dispatch/routing behavior | owning module (usually `readExtended.ts`); SPEC §5 numbered steps verbatim; README rows describing the new behavior; routing tests. |
| New capability/format/modality | format maps in `readExtended.ts`; SPEC §1 goal bullets, §6 format matrix + pipeline subsection, §9 structure if a file is added; README intro capability list + modality table row(s); tests. Move the item out of SPEC §14 (Future work) when implemented. |
| Config knob | `src/config.ts` types+defaults, repo `config.json` **values and `$docs` entries** (self-documenting), SPEC §3 defaults block, README Configuration section; default/parse tests. |
| ffmpeg pipeline (probe/crop/convert) | `src/ffmpeg.ts`; SPEC §6 relevant subsection (+§7 wire format only if serialization changes); live smoke below. |
| grid/locate math or rendering | `src/region.ts` constants + compute functions; model-facing param descriptions in `src/index.ts` and `PdfParams` (state the 49-cell cap, overlap default); README rows for grid/locate (Image + PDF tables); SPEC §6 region-finding bullets; tile-math tests. |
| Pi patch target | `src/patch/targets.ts`; PATCHES.md table; SPEC §8 targets table; sentinel version bump on anchor change; `test/patch.test.ts`. |
| Model-facing text only (guidance) | the `promptGuidelines` bullets in `src/index.ts` (≤6); tool description + param descriptions carry mechanics. Do not add a skill — see steering rules below. |
| Model-facing result notes (steering text in tool output) | owning module — notes live in dispatch code (`readExtended.ts`, `pdf.ts`), not in `index.ts`. These strings are the model's only window into config (capability gate, size cap, pagination) and the discovery path for escape hatches: when a new option lands (e.g. `frames=N`), update the dead-end notes to steer to it. Tests pin note wording. |

**Catch-all:** if a change matches no row, derive the row: list every surface that describes the changed behavior — model-facing (tool description, param descriptions, `promptGuidelines`, result notes) and user/repo-facing (README, SPEC, config `$docs`) — plus the code and tests that implement it. Any observable behavior change touches at least one surface in each column; if you can't name one, ask "who else needs to know about this change?" and add a row for the change type so the next session doesn't derive it again.

## Canonical facts that must agree everywhere

- Size caps, dpi, maxPagesPerCall, ffmpegTimeoutMs: identical numbers in `src/config.ts` defaults, repo `config.json` values **and** its `$docs` text, SPEC §3 block, README Configuration section.
- `GRID_MAX_CELLS = 49`: `region.ts`, every param description that states the cap (grid and locate share it), SPEC region-finding bullets.
- Patch targets: one table lives in `src/patch/targets.ts`; copies must match in PATCHES.md, SPEC §8, README Pi patches section (same count of targets).
- `ZOOM_UNAVAILABLE_HINT` has a single source (`ffmpeg.ts`); import it, never re-inline the wording.
- Capability summary: README intro list == GitHub repo description == tool description. Update all three when modality support changes.

## After every change — checklist

```bash
npx tsc && npm test          # rebuild dist/ (pi loads from dist/, no restart needed); tests must pass
# cross-check the matrix rows you touched; docs-only commits need this too
# sync every model-facing surface (tool description, param descriptions,
#   promptGuidelines, result notes) AND user/repo-facing doc (README, SPEC,
#   config $docs) that describes the changed behavior — both must match the
#   current implementation (the code is ground truth, not the docs) — before
#   committing
git add -A && git commit -m "feat|fix|docs|chore: ..."   # conventional commits, push origin main
npm install                  # when deps change → package-lock.json lands in same/next commit
```

Live smoke for user-visible behavior (probe + region drill-down):

```bash
FF=$(node -p "require('@ffmpeg-installer/ffmpeg').path") && \
  $FF -f lavfi -i testsrc=size=320x240:rate=25:duration=1 -f lavfi -i sine=frequency=440:duration=1 -shortest /tmp/probe-smoke.mp4
# then in a pi session: extendedRead path=/tmp/probe-smoke.mp4 info=true  → expect format/duration/WxH/Audio lines, no media loaded
```

Tests accompany math, parsers and routing changes (node:test fixtures; see `parseFfmpegProbe` fixture strings). Output-shape changes get a live smoke run.

## Model-facing steering rules

Guidance must be unconditional: short `promptGuidelines` bullets (≤6) in `src/index.ts`, merged into the system prompt's Guidelines section whenever the tool is active. Mechanics stay in the tool/param descriptions (travel with every request as part of the schema). No shipped skill, no `"skills"` entry in package.json — do not reintroduce one; skills depend on the model choosing to load them. Keep bullets ≤6 and never restate a param's mechanics twice.

## Design constraints

Zero new heavy dependencies by default (bundled ffmpeg + mupdf WASM + Photon only). No CV/ML deps: region finding stays CPU tiling (`grid` for known layouts, `locate` coarse-to-fine with overlap). A detector power mode (CLIP via Transformers.js) is future work — needs explicit opt-in config.

## Git & PR flow

Commits land on `main`. Feature work can branch and merge via PR; `gh` CLI is unavailable here — use the GitHub API (`curl`) with a token from `git credential fill`. New features ship as `feat:`; docs-only follow-ups as `docs:`; lockfile refreshes as `chore:`. The implementation branch plan (order + status) lives in `PLAN.md` — keep it current as branches land.
