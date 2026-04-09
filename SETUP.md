# Setup

1. Run `start.cmd` for the easiest local launch.
2. Open `http://127.0.0.1:8031/` in Chrome or another modern browser.
3. Allow audio playback when the browser asks.
4. Use the built-in `Install App` button once the browser exposes the PWA prompt.

## Local AI Setup

1. Start a local OpenAI-compatible endpoint such as LM Studio or Ollama with a compatible bridge.
2. Open the `Workspace` panel, switch to `Split` or `Code Focus`, and show the AI panel.
3. Use `Detect Local AI` to auto-discover a local endpoint when possible.
4. If you enter it manually, point `Local endpoint` at a localhost URL such as `http://127.0.0.1:11434/v1` or `http://127.0.0.1:1234/v1`.
5. Use `Test Connection` to confirm the model list before sending prompts.

## Notes

- The app loads `@strudel/web` from `unpkg.com`, but playback is driven by the built-in Web Audio engine.
- If the external Strudel runtime is unavailable, local playback, arrangement editing, sample lanes, recording, and project storage still work.
- Project shelf snapshots are local to the current browser profile because they are stored in IndexedDB.
