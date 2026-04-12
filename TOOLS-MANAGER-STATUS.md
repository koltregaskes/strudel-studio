# Tools Manager Status

Updated: 2026-04-12
Tool: Strudel Studio
Slug: `strudel-studio`
Owner session: `strudel-studio-session`

## Current State
- RAG: `Green`
- Completion: `95%`
- Phase: `review-candidate`
- Install or build state: repo implemented, local smoke target verified, public site configured
- Last reviewed: `2026-04-12`

## Highest-Priority Chunk Executed
- `Release Readiness panel`
- Projects + Export now includes an in-app release-readiness panel with a copyable review brief, explicit automated-vs-human sign-off guidance, and current project evidence so release review no longer depends on scattered docs alone.

## Evidence
- Repo-root smoke runner `scripts\run-release-smoke.cmd` passed locally on `2026-04-12` after being hardened to use a dedicated temporary browser profile and a larger virtual-time budget.
- Smoke summary still covered:
  - Simple View and Advanced View switching
  - `Audio Check` plus `Play`
  - sample import into the vocal lane
  - auto-banking into the project vault
  - Pattern Rack capture
  - reloading the banked clip into the FX lane
  - snapshot save and snapshot reload
  - full project export and re-import
- Dedicated headless DOM verification confirmed the new in-app release surface rendered:
  - `Release Readiness`
  - `2 manual checks remain`
  - `Copy Review Brief`
  - `Repo smoke runner exists at scripts\run-release-smoke.cmd`
- Export package schema remains `version: 6` with `projectClipBank` metadata plus `sampleAssets.clipBank`.

## Top Risks
1. Only a lightweight smoke suite exists so far; broader regression coverage is still limited.
2. Real speaker or headphone validation is still required.
3. PWA install flow still needs a normal-profile manual check.
4. Local AI depends on a user-supplied localhost runtime and is optional for release.
5. Draft autosave keeps project metadata, but raw imported audio is guaranteed through snapshots and exported project packages rather than plain localStorage alone.

## Blockers
- No in-repo blocker remains for review.
- External publishing connectors are still out of scope for this pass.

## Next Actions
- Run `scripts\run-release-smoke.cmd` before review and after risky changes.
- Use the in-app `Copy Review Brief` action during review handoffs.
- Run reviewer QA with real audio output.
- Do one normal-profile PWA install check.
- Expand the smoke suite only if broader automated coverage is worth the maintenance cost.

## Dependencies
- music-video-generator

## Surfaces
- Repo: https://github.com/koltregaskes/strudel-studio
- Public: https://koltregaskes.github.io/strudel-studio/
- Local smoke target: http://127.0.0.1:8031/

## Related Status Docs
- RELEASE_STATUS.md
- FEATURE_SNAPSHOT.md

## Notes
- `TOOLS-MANAGER-STATUS.md` is the manager-facing summary.
- `RELEASE_STATUS.md` is the release-facing snapshot.
- `FEATURE_SNAPSHOT.md` is the shipped-control baseline for regression checks.
