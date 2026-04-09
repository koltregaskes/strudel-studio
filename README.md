# Strudel Studio

Strudel Studio is a click-first browser music studio with a programmable Strudel layer on top. The UI is the main surface, but the code editor, arrangement engine, sample lanes, recording flow, and local AI panel are all built in.

## Current Product Shape
- Local Web Audio playback with no server-side dependency
- Two workspace shells:
  - `Simple View` for a one-screen console layout
  - `Advanced View` for a tabbed workstation
- Session metadata for title, tempo, key, and notes so projects read like real studio workspaces
- Arrangement timeline plus per-section editor with drag reorder, drag resize, duplicate controls, and structure templates
- Scene presets for intro, main, breakdown, build, climax, and outro
- Pattern Rack for capturing multiple groove snapshots and scenes inside one project
- Beat Designer for kick, snare, and hats, plus quick groove-action buttons and sequencing utilities
- Mixer with mute, solo, pan, and level controls
- Four sample lanes: vocal, FX, texture, and perc one-shots
- Sample + Clip Library for loaded lane assets, lane targeting, auditioning, and cleanup
- Licensing-aware sample browser that ships templates, not copyrighted audio
- Audio diagnostics with meter activity, warning states, and a direct `Audio Check` trigger
- Split-screen and code-focus workspace layouts
- Local-only AI assistant for code and composition help via an OpenAI-compatible localhost endpoint
- Browser project shelf with local snapshots stored in IndexedDB
- Export Dock with live JSON preview, copy, download, and full project import/export support
- Recording export from the local mix
- PWA install support for desktop and Android-style home screen use
- Repo-tracked feature inventory in `FEATURE_SNAPSHOT.md`

## Why This Repo Exists
- Keep the Strudel-inspired coding layer
- Keep the studio UI as the main experience
- Stay licensing-aware around samples and presets
- Build a real product instead of a throwaway demo

## Launch Notes
- Windows-first local workflow is the primary target
- Android is currently served through the PWA path
- Native desktop or native Android wrappers can be evaluated later if the PWA path proves too limiting

## Manager Visibility
- Current status for the Tools Manager lives in `RELEASE_STATUS.md`.
- The shipped feature baseline lives in `FEATURE_SNAPSHOT.md`.
