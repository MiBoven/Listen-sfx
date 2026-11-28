# Listen

**With G you get some fairy glisten**

Listen is a browser app for making cinematic sound effects fast, without digging through a thousand options. You can generate 8-bit blips, explosions, generator shutdowns, sweeping whooshes and goosebump choirs from presets. You can also record your own sounds (a knock, a clap, a scrape) and turn them into something big with one tap. Everything runs on your device and nothing is uploaded.

**Live at:** [listen.michels.world](https://listen.michels.world)

## Features

### Create — presets
- **Themes**: Standard, Sci-Fi, Fantasy, RPG, Horror and Retro (8-Bit), each with 8 fitting sounds, e.g. Sci-Fi → *Laser shot, Shield up, Generator shutdown, Teleport, Spaceship fly-by*.
- Preview a sound, make a quick **🎲 Vary** version, or add it to the track.
- **Edit in Workshop** opens the selected preset in the Sound Workshop, and **New sound** starts there from a single sine wave.

### Sound Workshop
- A full-screen editor for building sounds step by step, with its **own undo/redo**.
- Every sound is made of **1–4 layers** that play together. Every layer has the **same sections with the same controls**, so a sound can always be understood and rebuilt:
  - **Source**: the raw material, either Sine, Triangle, Saw, Square, **Noise** (bright, medium, dark) or **Notes**. Notes come with an instrument (E-piano, Bell, Pluck, Organ, Pad, Chip), a play mode (single note, chord, arpeggio, random notes) and a mood (Major, Minor, Pentatonic, Dreamy, Mysterious, Dark, Power).
  - **Pitch**: start pitch → end pitch with a curve (for Notes: root note and glide, plus your own notes, see below)
  - **Volume**: **Level** and **Length** sit directly under every layer head and are always reachable; start time, fade in and fade out are in the collapsible Volume section
  - **Brightness**: low-, high- or band-pass filter, start → end with a curve, resonance
  - **Movement**: vibrato, pulse, pan start → pan end, stereo width
  - **Character**: drive and bit depth
- Source and Pitch are open by default; the other sections are collapsed and show a one-line summary.
- **Controls**: choices (Source, Noise color, Instrument, Play, Mood, Filter …) are buttons. Numbers are round knobs: tap one, then swipe the **vertical jog wheel** next to them up or down. A dot on the wheel marks the default value, and a short note explains what the setting does. Double-tap a knob to reset it.
- **Mix**: the wave of the whole sound with a playhead. Tap or drag on it to set the position. ▶/❚❚ plays and pauses, ■ stops and returns to the start. 📌 pins the mix at the top while you scroll.
- **Layer waves**: every layer shows its own wave with a playhead while playing. Tap the wave to switch between *layer only* (its own length) and *in the mix* (its position within the whole sound).
- **Autoplay** (Off / Layer / Mix, default Off) decides what plays after a change. *Layer* plays the changed layer, *Mix* plays the whole sound.
- **Pick your own notes** for Notes layers: tap keys on a two-octave **piano keyboard** (octave buttons ◀ ▶), tap a **6-string fretboard** (frets 0–12, standard tuning), or type note names and chords (`C E G`, `A3`, `Am`, `G7`, `Fmaj7`, `Dsus4`; German `H`, `Fis`, `Es` also work). Picked notes replace the automatic root note and chord. *Single* plays the first note, *Chord* plays all of them, *Arpeggio* plays them in the order you picked, *Random* picks among them. Each tapped note is previewed with the layer's instrument.
- Example: *Big explosion* = bright noise getting darker (the blast) + a sine dropping from 150 to 45 Hz (the punch) + dark noise fading in (the rumble).
- ▶ on a layer plays only that layer and turns into ■ to stop it. Switching layers off lets you hear what each one adds. Layers can be duplicated and removed.
- **Variants**: copy the sound as variant B, C … change it and tap the letters to compare.
- Start from any preset or from a simple sine layer. **Add to track**, or **Update clip** when the Workshop was opened from a clip (*Edit in Workshop*).

### My Sounds
- A library shared by **all projects**: save sounds from the Workshop or any clip (*Save to My Sounds*, effect chain and trim included).
- Play, add to the track, rename or delete saved sounds.

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
- Tap a clip to select it, then drag it to move it. Clip actions: **Edit in Workshop** (Workshop sounds), **Split** at the playhead, **Trim to selection**, **Duplicate**, **Save to My Sounds**, **Delete**.
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

All sounds are synthesized sample by sample in plain JavaScript at 48 kHz, and no sample files are bundled. Each Workshop layer runs the same pipeline:

source (oscillator / noise / instrument notes) → pitch curve and vibrato → state-variable filter → envelope and pulse → drive and bit reduction → panning

The layers are then mixed and normalized. The instruments are synthesized: E-piano as 2-operator FM, Bell as inharmonic partials, Pluck as a Karplus-Strong string, Organ as drawbar harmonics, Pad as detuned saws, Chip as a square wave. Each layer uses a seeded random generator, so a clip stores only its *recipe* (layers, variants, seed). This keeps projects tiny and lets every sound be reopened in the Workshop later.

Effect chains are re-rendered from the original source whenever a step changes, and rendered results are cached. Pitch and Stretch use a WSOLA time-stretcher. Reverb runs through a generated impulse response in an `OfflineAudioContext`. Imported and recorded audio is decoded with `decodeAudioData` and stored as a blob in IndexedDB (recordings and trimmed or video sources as WAV). Projects and *My Sounds* are stored there as well. WAV encoding is built in, and MP3 encoding uses the vendored [lamejs](https://github.com/zhuker/lamejs).

Clips made with the generator of v0.1.0 keep playing. They are still rendered by the old engines but can no longer be opened for editing.

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
