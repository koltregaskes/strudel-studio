# Strudel Studio Release Status

Last updated: 2026-04-11
Review state: Review candidate
Repo: `W:\Repos\_My Tools\strudel-studio`
Branch: `main`
Manager status: `TOOLS-MANAGER-STATUS.md`
Release snapshot: `RELEASE_STATUS.md`
Feature baseline: `FEATURE_SNAPSHOT.md`

## Shipped
- Simple View console shell and Advanced View workstation are implemented.
- Local Web Audio transport, arrangement editing, Pattern Rack, sample lanes, project snapshots, and project export/import are working locally.
- Audio diagnostics, `Audio Check`, PWA manifest, and service worker are in place.
- Project Clip Vault is now part of the shipped workflow:
  - imported lane audio is automatically banked per project
  - banked clips can be previewed and reloaded into any lane
  - banked clips persist through snapshot saves and full project export/import packages
- Repo baseline docs include `FEATURE_SNAPSHOT.md` for regression visibility.

## Verified This Pass
- Local browser smoke ran on 2026-04-11 against `http://127.0.0.1:8031/`.
- Simple View and Advanced View switching worked.
- `Audio Check` plus `Play` moved diagnostics to `Running` and `Signal present`.
- Importing `vault-smoke.wav` created one vault clip and updated the session clip count to `1`.
- Pattern Rack capture created one rack card from the current groove.
- Loading the vault clip into the FX lane restored the clip and its suggested trigger steps.
- Saving and reloading the snapshot `Vault Smoke Session` restored the vault clip successfully.
- Exported project packages now use schema `version: 6` with `projectClipBank` metadata plus `sampleAssets.lanes` and `sampleAssets.clipBank`.
- Importing the exported project restored both lane clip state and the project vault clip.
- Browser console showed no errors during the pass.

## Top 5 Risks / Gaps
1. No automated regression suite exists yet, so confidence still depends on browser smoke and manual QA.
2. Real speaker or headphone validation on a normal user machine is still required before launch.
3. The PWA install flow has shell support in place but still needs a non-automation, everyday-profile check.
4. The local AI panel remains dependent on a user-supplied localhost model runtime and should be treated as optional for release.
5. Draft autosave stores project state metadata, but raw imported audio is guaranteed through snapshots and exported project packages rather than plain localStorage alone.

## Blockers
- No in-repo blocker remains for review.
- External YouTube, TikTok, and Instagram connections are intentionally out of scope for this local studio release pass.

## Next Actions
- Run reviewer QA with real speakers or headphones.
- Do one normal-profile PWA install smoke.
- Decide whether to add an automated smoke harness before launch-candidate sign-off.
