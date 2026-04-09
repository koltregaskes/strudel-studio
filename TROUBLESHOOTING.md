# Troubleshooting

- **No sound plays after pressing `Play`**: Interact with the page first, then press `Play` again so the browser allows Web Audio to start. If you still hear nothing, run `Audio Check` in `Audio Diagnostics` and inspect the context, meter, and warning states.
- **The code panel says Strudel evaluation failed**: The built-in engine is still the main playback path. You can keep working and exporting even if the external Strudel runtime does not cooperate.
- **The AI panel refuses a request**: The assistant only accepts localhost endpoints. Use `127.0.0.1`, `localhost`, `0.0.0.0`, or `::1`.
- **The Install button is disabled**: The browser has not exposed a PWA install prompt yet, or the app is already installed in that profile.
- **A snapshot does not appear in Project Shelf**: Make sure the browser allows IndexedDB/local storage for the site and that you are not in a blocked private session.
- **Imported samples are missing after switching browsers or profiles**: Local shelf snapshots live in the current browser profile. Use `Export Project` if you want a portable file.
- **Imported samples are missing after an imported JSON file**: Full exported project files now carry embedded sample assets, but older exports may not. Re-import the sample manually if needed.
- **The arrangement looks broken after an old draft loads**: Use `Restore Default` in `Track Structure`, then rebuild from the shelf or import a newer project file.
- **A `Thumbs.db` file appears**: That is a Windows Explorer cache file and is ignored by git.
