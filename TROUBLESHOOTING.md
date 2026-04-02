# Troubleshooting

- **No sound plays after pressing `Play`**: Check whether the browser blocked audio autoplay. Press `Play` again after interacting with the page, and make sure your system output device is active.
- **The status says local playback is active but Strudel evaluation failed**: That is acceptable for this app. The built-in engine handles preview playback; the Strudel panel is mainly for export and experimentation.
- **No live code update appears in the Strudel panel**: The external Strudel script may be blocked or unavailable. Local playback should still work.
- **The song structure looks wrong after importing a project**: Use `Restore Default` in the arrangement section to rebuild the standard layout, then import only the parts you still want.
- **A vocal sample vanishes after importing a project file**: Reload the sample from disk. Project files keep the sample settings, but not the raw audio file itself.
- **An FX sample vanishes after importing a project file**: Reload the FX or stab sample from disk. The project keeps the slice and step settings, but not the raw audio file.
- **A `Thumbs.db` file keeps appearing**: That is a Windows Explorer cache file and is ignored by git in this repo.
