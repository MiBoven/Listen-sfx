# Listen

**With G you get some fairy glisten**

Listen is a browser app for making cinematic sound effects fast, without digging through a thousand options. You can generate 8-bit blips, explosions, generator shutdowns, sweeping whooshes and goosebump choirs from presets. You can also record your own sounds (a knock, a clap, a scrape) and turn them into something big with one tap. Everything runs on your device and nothing is uploaded.

**Live at:** [listen.michels.world](https://listen.michels.world)

## Features

### Create — sound generator
- **Themes**: Standard, Sci-Fi, Fantasy, RPG, Horror and Retro (8-Bit). Each theme has its own list of fitting sounds, e.g. Sci-Fi → *Laser shot, Shield up, Generator shutdown, Teleport, Spaceship fly-by*.
- Picking a sound moves all controls to matching values. Eight synthesis engines are behind the presets:
  - **8-Bit**: chip oscillator with slides, jumps and repeats
  - **Impact**: noise blast, low thump, debris and rumble
  - **Power**: motors, generators and risers sweeping up or down, with rotor wobble and a mechanical clunk
  - **Whoosh**: air moving past, including left → right movement and Doppler
  - **Zap**: FM lasers, blasters and teleports
  - **Sparkle**: glittering bell tones (fairy dust, spells, treasure)
  - **Goosebumps**: swelling choir, strings or glass chords with shimmer
  - **Drone**: dark living textures and metal scrapes
- **Infinity dials**: every setting is a round button that shows its value. Tap one, then swipe the tick ruler below it left or right (like a phone photo editor). A short note under the ruler explains what that setting does to the sound. Double-tap a button to reset it to the preset value. A dot on the ruler marks the preset value.
- **🎲 Vary** creates a new variation around the chosen preset with one tap.
- Sounds play automatically after a change (can be switched off in Settings).
- Generated clips stay editable: **Edit sound** reloads their settings into the generator.

### Magic Transform — effect chains
- **Recipes** apply a whole effect chain with one tap: *Monster, Giant step, Cinema hit, Explosion punch, Sci-fi door, Sword clang, Robot, Ghost, Space echo, Underwater, Radio, Pixie*.
- Every clip shows its effect chain step by step, so you can see what is happening: each step can be switched on/off, edited (same dials), moved up or down, or removed.
- 18 effects: Tape speed, Pitch (keeps length), Stretch (keeps pitch), Reverse, Distortion, Bitcrusher, Filter, Bass (incl. sub octave), Echo (normal / ping-pong), Reverb, Move L/R, Ring modulator, Flanger, Tremolo, Cinema boom (sub boom, can line up with the loudest hit), Volume & fades, Normalize, Trim silence.
- **Save as recipe** stores your own chains. They appear as extra chips, can be deleted, and work across projects.
- **A/B: original** plays the untouched source. Effects are non-destructive: the source sound is never changed.

### Add audio
- Load audio files, or video files (only the sound is used), by tapping or drag & drop.
- **Share to Listen**: once installed (Android), audio and video can be shared directly into the app.
- Long files (default: over 5 minutes, adjustable; 0 = always) first open a **section picker** with a waveform, start/end sliders and a preview, so only the part you need is kept. *Always pick a section first* forces the picker for every file.
- **Record with the microphone**, with a level meter. After recording, the app jumps straight to Magic Transform.

### Track & export
- One audio track: clips can be placed freely, overlap (they are mixed), and snap to other clips, the playhead and 0.
- Tap a clip to select it, then drag it to move it. Clip actions: **Edit sound** (generated clips), **Split** at the playhead, **Trim to selection**, **Duplicate**, **Delete**.
- Tap the ruler to place the playhead; drag along the ruler to select a range. Play, back to start, loop, and zoom (−, fit, +).
- **Export** everything, the current selection, or the selected clip as **MP3** (320/192/128 kbps) or **WAV** (16/24-bit), in stereo or mono, with optional normalization (peak −1 dB). Exports can be downloaded or shared via the share sheet.
- **Undo/redo** (default 20 steps, adjustable 5–100 in Settings). Desktop shortcuts: Space = play/pause, Ctrl/Cmd+Z / Ctrl+Y = undo/redo, Delete = delete clip.

### Projects
- Projects save automatically while you work and reopen on the next visit.
- **Projects…** in the menu: open, rename, duplicate or delete projects, create new ones, and see the storage used.
- Audio that is no longer used is cleaned up when a project is opened.

### General
- Dark mode by default (toggle in the menu), mobile-first layout, fullscreen button
- Installable PWA, works offline
- No tracking, no cookies, no third-party requests

## How it works

All sounds are synthesized sample by sample in plain JavaScript at 48 kHz, using oscillators, filtered noise, FM and additive bell partials. No sample files are bundled. Each engine draws from a seeded random generator, so a clip stores only its *recipe* (engine, parameters, seed). This keeps projects tiny and lets every sound be edited again later. Effect chains are re-rendered from the original source whenever a step changes, and rendered results are cached. Pitch and Stretch use a WSOLA time-stretcher. Reverb runs through a generated impulse response in an `OfflineAudioContext`. Imported and recorded audio is decoded with `decodeAudioData` and stored as a blob in IndexedDB (recordings and trimmed or video sources as WAV). Projects (JSON) are stored there as well. WAV encoding is built in, and MP3 encoding uses the vendored [lamejs](https://github.com/zhuker/lamejs).

## Files

- `index.html`: markup
- `style.css`: styling
- `app.js`: synth engines, effects, timeline, projects, import/recording, export
- `sw.js`: service worker (offline cache, share target)
- `site.webmanifest`: PWA manifest including `share_target`
- `favicon.ico`, `android-chrome-192x192.png`, `android-chrome-512x512.png`: repo root
- `icons/`: `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png`, `favicon.webp`, `og-image.png` (link preview without transparency)
- `vendor/lamejs/lame.min.js`: MP3 encoder (**download it once**, see below)

## MP3 encoder (vendored, one-time download)

Listen never loads anything from a CDN at runtime. Download the MP3 encoder once and commit it:

1. Download **https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js**
2. Save it as `vendor/lamejs/lame.min.js`

```
vendor/
└── lamejs/
    └── lame.min.js
```

Without this file the app still works completely, but MP3 is greyed out in Export and only WAV is available.

## Browser support

Works in current Chrome, Edge, Firefox and Safari. Which video and audio formats can be read depends on the browser: MP3, WAV, AAC/M4A, MP4 and WebM work almost everywhere, while FLAC/Opus/OGG can be missing in older Safari versions. Sharing into the app (share target) is supported on Android with Chrome/Edge when the app is installed.
