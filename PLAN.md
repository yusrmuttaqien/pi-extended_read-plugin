# PLAN.md — implementation plan

Execution tracker for the future work defined in **SPEC.md §13**. The SPEC is the source of truth for *what* each feature is; this file tracks *how* we land it (branch order, status). Keep the two in sync: when a branch ships, move its item out of SPEC §13 into the main spec body and flip its status here.

## Branch sequence (dependency order)

| # | Branch | Contains | Status |
|---|--------|----------|--------|
| 1 | `purge-grid-locate` | Purge `grid` + `locate`: params, `src/region.ts`, dispatch branches, tests, docs. Prerequisite for trace. | done (PR #2) |
| 2 | `patch-eviction` | Patch eviction: ffmpeg gate → video-as-frames → audio out → JPEG standardization → delete `src/patch/` + `/extended-read-patch`. End state: patch-free. | done (PR #3) |
| 3 | `trace` | Trace (region-finding v2): numbered overlay + crop-from-untraced-original, 0-100 coords, split-for-legibility, temp reuse, `/extended-read-clean`, per-session temp dir. | done |
| 4 | `docx` | DOCX reader (`mammoth`). | pending |
| 5 | `pages` | Pages (`.pages`) reader (macOS-only). | pending |
| 6 | `notebook` | Notebook (`.ipynb`) reader. | pending |

Branches 4–6 are independent (no deps on 1–3 or each other); land in any order / in parallel.

## Next up

**Branch 4 — `docx`.** DOCX reader via `mammoth` (pure JS, no PDF conversion). Design is in SPEC §13.

## Notes

- **Patch eviction** (done, PR #3): the 4 changes were interdependent and the patch deletion landed last, in the same branch.
- **Trace** (done): landed directly on `main` (no branch/PR) — a deviation from the branch+PR convention used for branches 1–2.
- **Pending (not branches yet):** Resize options exposure (open decision), Compaction interleave (blocked on a future pi compaction feature), Local omni model (SPEC §13 — wants a branch after `patch-eviction`, not committed yet).

## Conventions

- One branch = one coherent, shippable unit.
- Per branch: implement → `npx tsc && npm test` → live smoke if user-visible → commit (conventional) → push `origin`.
- SPEC §14 items move into the main spec body as they ship; status flips here.
