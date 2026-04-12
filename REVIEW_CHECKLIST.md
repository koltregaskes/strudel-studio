# Strudel Studio Review Checklist

This file is the plain-English answer to "what do we still need to check before launch?"

## What A Regression Suite Means

A regression suite is just a repeatable safety check.

In normal language:
- we make changes
- we run the same checks again
- if something that used to work has broken, we catch it early

For Strudel Studio, the important idea is not "lots of fancy tests." It is "a small set of reliable checks we can rerun whenever we change the tool."

## What Is Automated Now

Run this from the repo root:

```bat
scripts\run-release-smoke.cmd
```

That smoke suite checks:
- the app loads locally
- the PWA shell files respond
- the service worker registers
- `Simple View` and `Advanced View` switch correctly
- `Audio Check` and `Play` drive the diagnostics
- arrangement editing can add a section
- importing a sample banks it into the project clip vault
- Pattern Rack capture still works
- a banked clip can be loaded into another lane
- snapshot save still works
- full project export and import still work

## What Still Needs A Human Check

These are the few things automation cannot fully prove:

1. Real audio output
   - Open the app in your normal browser profile.
   - Press `Audio Check`.
   - Press `Play`.
   - Confirm you can actually hear sound through your speakers or headphones.

2. PWA install
   - Open the app in a normal browser window.
   - Use the browser's install option or the app install button if it appears.
   - Confirm the installed app opens and looks normal.

3. Local AI, if you want it in scope
   - Start your local model runtime.
   - Open the Local AI panel.
   - Press `Detect Local AI` or `Test Connection`.
   - Send one simple prompt and confirm you get a reply.

## What I Mean By The Remaining Notes

- "No automated regression suite"
  - This used to mean we had no reusable safety check at all.
  - It now means we have a lightweight smoke suite, but not a huge full test system.

- "Real speaker or headphone validation still required"
  - A machine can see buttons and meter movement.
  - It cannot honestly tell us whether you personally heard sound on your actual setup.

- "Normal-profile PWA install check still required"
  - Automation can confirm the manifest and service worker.
  - It cannot fully replace a normal "install this app and open it" check.

- "Local AI depends on a local runtime"
  - The AI panel is optional.
  - It works only if you have a compatible local model server running.

- "Draft autosave vs snapshots/export"
  - Draft autosave remembers the project state.
  - If imported audio really matters, snapshots and exported project packages are the safer backup path.

## Simple Go / No-Go Pass

If you want the shortest practical review:

1. Run `scripts\run-release-smoke.cmd`.
2. Manually confirm you can hear sound.
3. Manually confirm the app installs normally as a PWA.
4. Optionally confirm local AI if you want that included in review.

If those pass, we are in strong shape for review.
