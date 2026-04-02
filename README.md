# Strudel Studio Prototype

A browser-based control surface and sketch pad for recreating The Prodigy's "Everybody's in the Place".

This repo now acts as the main lightweight path toward `Strudel Studio`, with dependable local playback, editable generated code, and the best rescued ideas from the old Remix branch.

## What It Does
- Plays a local synth-and-drum preview directly in the browser
- Shows the track structure, track elements, and effect controls in one page
- Generates an editable Strudel sketch alongside the live playback controls
- Lets you tweak the code and export it for use in the official Strudel environment
- Records the local mix and exports a take from the browser
- Imports a vocal sample, slices it, changes playback rate, and triggers it on chosen steps
- Adds clickable scene presets for intro, main, breakdown, build, climax, and outro moods
- Provides a 16-step vocal sequencer with quick audition and clear-sample controls
- Saves project state in the browser and exports/imports project JSON
- Includes a reusable example-code library for fast song starts
- Lets you edit the arrangement by section, bars, and scene from the web UI

## What Was Salvaged From Remix

- The example library concept
- The editable arrangement / track-structure idea
- The broader “Studio” framing rather than a throwaway test harness

## Current Status

- Local playback path works without relying on the broken Strudel embed route
- The repo is useful as a real browser-based music sketch tool
- It is now the clearer single path to continue under the renamed `strudel-studio` repo
