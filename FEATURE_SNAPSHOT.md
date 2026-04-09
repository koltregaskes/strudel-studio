# Strudel Studio Feature Snapshot

Date: 2026-04-09
Project snapshot schema: `version: 5`
Purpose: repo-tracked baseline for shipped controls, views, and behaviors so future audits can confirm nothing was silently removed.

## Workspace Views
- `Simple View` is the default console shell.
  - Persistent top summary strip for session overview, transport, and audio diagnostics.
  - Left dock for arrangement, scene, and pattern navigation.
  - Center dock for beat design, mixer, effects, and visual feedback.
  - Right dock for sample lanes and the sample/clip browser.
  - Lower deck drawer for workspace/code, projects/export, factory starters, and system notes.
- `Advanced View` is the tabbed workstation.
  - `Arrange`
  - `Sound`
  - `Samples`
  - `Code + AI`
  - `Projects + Export`

## Shipped Sections
- Active Session deck
- Transport and recording controls
- Audio Diagnostics
- Track Structure timeline and arrangement editor
- Scene Arranger
- Pattern Rack
- Beat Designer
- Mixer
- Sample lanes for `Vocal`, `FX`, `Texture`, and `Perc`
- Sample + Clip Library
- Global Effects
- Pattern Visualizer
- Factory Starting Points
- Workspace with code editor and local AI panel
- Project Shelf
- Export Dock
- Studio Notes

## Session and Project Controls
- Session metadata:
  - Title
  - Tempo
  - Key
  - Notes
- Project actions:
  - New project
  - Duplicate current project into a new draft
  - Save local snapshot
  - Export full project package
  - Import project package
- Project persistence:
  - Draft autosave in local storage
  - Snapshot shelf in IndexedDB
  - Portable project JSON with embedded sample assets

## Transport and Diagnostics
- `Play`
- `Record`
- Take label
- Auto-stop at arrangement end
- Master volume
- Tempo slider
- Progress bar and time display
- Audio diagnostics:
  - Audio context state
  - Engine-running status
  - Output-path status
  - Meter activity
  - Solo/master warning line
  - `Audio Check` tone trigger

## Arrangement and Scene Controls
- Arrangement timeline:
  - Click section to load its scene preset
  - Drag sections to reorder
  - Drag right-side handle to resize bars
  - Timeline current-position marker during playback
- Arrangement editor row controls:
  - Rename
  - Reassign scene
  - Edit bars numerically
  - `Load`
  - `Up`
  - `Down`
  - `Duplicate`
  - `Remove`
- Structure templates:
  - `Radio Edit`
  - `DJ Tool`
  - `Extended Mix`
- Global arrangement actions:
  - `Add Section`
  - `Restore Default`
- Scene presets:
  - `Intro`
  - `Main`
  - `Breakdown`
  - `Build`
  - `Climax`
  - `Outro`

## Pattern and Beat Controls
- Pattern Rack actions:
  - Capture current pattern
  - Rename snapshot
  - Load snapshot
  - Refresh snapshot from current groove
  - Duplicate snapshot
  - Delete snapshot
- Beat Designer lanes:
  - Kick steps
  - Snare steps
  - Hat steps
- Rhythm preset buttons:
  - `Club Drive`
  - `Break Swing`
  - `Half-Time`
- Rhythm quick actions:
  - `Tighten`
  - `Full Hats`
  - `Break Shuffle`
  - `Surprise`
  - `Clear Groove`
- Sequencer utilities by lane:
  - Shift left
  - Shift right
  - Densify
  - Thin out
  - Clear lane

## Mixer and Sound Controls
- Mixer strips for:
  - Main Break
  - Kick
  - Bass
  - Stabs
  - Lead
  - Vocal
  - FX
  - Percussion
  - Texture
  - Perc Shot
- Per-strip controls:
  - Volume
  - Pan
  - Mute
  - Solo
- Global effects:
  - Reverb
  - Delay
  - Filter
- Pattern visualizer:
  - Beat indicator ring set
  - Cycle counter

## Sample and Clip Controls
- Four sample lanes:
  - Vocal
  - FX
  - Texture
  - Perc
- Per-lane controls:
  - File import
  - Step-text input
  - Step grid buttons
  - `Audition`
  - `Clear`
  - Slice start
  - Slice end
  - Rate
  - Reverse toggle
- Clip library card actions:
  - `Audition`
  - `Aim Browser`
  - `Clear Lane`
- Sample browser controls:
  - Search
  - Lane targeting
  - Preset apply

## Code and AI Controls
- Workspace layouts:
  - `Studio`
  - `Split`
  - `Code Focus`
- Workspace actions:
  - `Show Code` / `Hide Code`
  - `Show AI` / `Hide AI`
  - `Update`
  - `Reset`
  - `Export`
- Local AI settings:
  - Endpoint
  - Model
  - System prompt
- Local AI actions:
  - `Detect Local AI`
  - `Test Connection`
  - `Clear Chat`
  - Prompt suggestions
  - `Send`
- Assistant response actions:
  - Insert code
  - Replace code
  - Replace and update
  - Copy code

## Export and Factory Content
- Export Dock actions:
  - Refresh JSON
  - Copy JSON
  - Download JSON
- Factory Starting Points actions:
  - Load starter into code panel
  - Copy starter code
- Factory sample browser ships lane templates and metadata only.

## Contextual or Intentionally Disabled Controls
- `Install App`
  - Disabled until the browser exposes a PWA install prompt.
  - Disabled again after installation or when running in standalone mode.
- Arrangement `Up`
  - Disabled on the first section.
- Arrangement `Down`
  - Disabled on the last section.
- AI response code actions appear only when a response includes an extracted code block.

## Starter Content vs User Content
- Factory starter content:
  - Built-in lane sounds for vocal, FX, texture, and perc fallback playback
  - Factory Starting Points code sketches
  - Sample-browser template presets
- User-owned content:
  - Imported lane audio files
  - Session metadata
  - Arrangement edits
  - Pattern rack snapshots
  - Mixer and effect edits
  - Custom Strudel code
  - Local AI conversation history
  - Saved project shelf snapshots

## Production Readiness Notes
- The built-in Web Audio engine is the main transport playback path.
- The Strudel code panel remains available for code experiments, exporting, and AI-assisted editing.
- The local AI panel is restricted to localhost-style endpoints.
- No visible control in the shipped interface should be decorative-only; buttons are expected to have a real action or an intentional disabled state.
