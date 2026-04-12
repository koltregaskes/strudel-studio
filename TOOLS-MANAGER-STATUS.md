# Tools Manager Status

Updated: 2026-04-11
Tool: Strudel Studio
Slug: `strudel-studio`
Owner session: `strudel-studio-session`

## Current State
- RAG: `Green`
- Completion: `94%`
- Phase: `review-candidate`
- Install or build state: repo implemented, local smoke target verified, public site configured
- Last reviewed: `2026-04-11`

## Highest-Priority Chunk Executed
- `Project Clip Vault`
- Imported clips now auto-bank per project, can be previewed or loaded into any lane, and persist through snapshots plus full project export/import packages.

## Evidence
- Browser smoke on `http://127.0.0.1:8031/` passed for:
  - Simple View and Advanced View switching
  - `Audio Check` plus `Play`
  - sample import into the vocal lane
  - auto-banking into the project vault
  - Pattern Rack capture
  - reloading the banked clip into the FX lane
  - snapshot save and snapshot reload
  - full project export and re-import
- Export package schema is now `version: 6` and includes `projectClipBank` metadata plus `sampleAssets.clipBank`.
- Browser console showed no errors during the pass.
- Repo-root smoke runner `scripts\run-release-smoke.cmd` now exists and passed locally on 2026-04-12.

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
