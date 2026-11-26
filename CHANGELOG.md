# Changelog

### 0.3.0 — 2026-11-26 — Workshop controls, notes & playback
- Choices are now buttons; numbers use round knobs with a vertical jog wheel beside them (also in Magic Transform)
- Level and Length are always visible under each layer head; the other volume settings stay collapsible
- Each layer shows its wave with a playhead; tap it to switch between "layer only" and "in the mix"
- Mix wave with a positionable playhead, play/pause, stop and a pin to keep it at the top
- Layer ▶ turns into ■ while playing
- Autoplay with three modes (Off / Layer / Mix), default Off, switchable in the Workshop
- Pick your own notes for Notes layers: piano keyboard, 6-string fretboard or text (note names, octaves and chord names, incl. German H/Fis/Es)
- Create tab: "New sound" starts with a single sine layer, "Edit in Workshop" opens the selected preset
- Fixed: knob values were drawn above the sticky Workshop buttons
- Fixed: knobs with negative values (e.g. Pan) showed a wrong, half-filled ring

### 0.2.0 — 2026-11-26 — Sound Workshop
- New full-screen Sound Workshop with its own undo/redo: every sound is built from 1–4 layers with identical sections (Source, Pitch, Volume, Brightness, Movement, Character)
- Sources: Sine, Triangle, Saw, Square, Noise (bright/medium/dark) and Notes with six synthesized instruments (E-piano, Bell, Pluck, Organ, Pad, Chip), four play modes and seven moods
- Variants (A, B, C …) to compare ideas side by side; solo and mute per layer; duplicate and remove layers
- Source and Pitch open by default, other sections collapsed with a summary line
- All 48 presets rebuilt from layers, so they can be opened and rebuilt step by step; the crackling explosion was replaced
- Clips from the Workshop can be reopened via "Edit in Workshop" and updated
- My Sounds: a library shared by all projects, filled from the Workshop or from any clip (effects and trim included)
- Create tab simplified to preset browsing with Preview, Vary, Add to track and Open in Sound Workshop
- Fixed: ruler of the dials could be drawn squashed
- Clips made with the v0.1.0 generator still play but can't be edited anymore

### 0.1.0 — 2026-11-26 — First release
- Sound generator with six themes (Standard, Sci-Fi, Fantasy, RPG, Horror, Retro) and 48 presets built on eight synthesis engines (8-Bit, Impact, Power, Whoosh, Zap, Sparkle, Goosebumps, Drone)
- Infinity dials: round value buttons plus a swipeable tick ruler with an explanation of what each setting does; double-tap resets to the preset value
- 🎲 Vary for instant variations, and optional auto-play after every change
- Magic Transform: 12 one-tap recipes, a visible step-by-step effect chain (on/off, edit, reorder, remove), 18 effects and your own saved recipes
- Import of audio and video files (sound only) via picker, drag & drop or Android share target, with a section picker for long files (threshold adjustable)
- Microphone recording with level meter
- One track with free clip placement, snapping, split, trim to selection, duplicate and delete; playhead, range selection, loop and zoom
- Export of everything, the selection or a single clip as MP3 (via vendored lamejs) or WAV 16/24-bit, stereo or mono, with optional normalization; download or share
- Projects with autosave, project list (open, rename, duplicate, delete) and storage info
- Undo/redo with 20 steps by default (adjustable in Settings)
- Dark mode by default, installable PWA with offline support
