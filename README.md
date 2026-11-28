# JPG75 is Enough

A tiny, privacy-friendly web app that converts images to JPG at a reduced quality — entirely in your browser. No files are ever uploaded to a server.

**Live at:** [jpg75.michels.world](https://jpg75.michels.world)

## Features

- **Header** in the style of the other apps in the suite: app logo + bold title top-left with a short subtitle below, Vollbild (fullscreen) / Darkmode / ⋮-menu icons top-right. Clicking the logo/title area returns to the top of the page (kept consistent with the other apps in the suite, even though this one has no separate home view). The ⋮-menu currently only holds "About" (name, version, short description, privacy note).
- Select or drag & drop one or multiple images (any browser-supported image format: PNG, WEBP, GIF, BMP, JPG, ...), or paste directly from the clipboard — e.g. a Windows screenshot copied via Snipping Tool / Win+Shift+S:
  - **Desktop:** Ctrl+V / Cmd+V anywhere on the page
  - **Mobile:** a dedicated "Paste image from clipboard" button (Ctrl+V has no mobile equivalent), e.g. after using "Copy to clipboard" on an Android screenshot's share sheet
- **Bilder / Dateien** toggle above the picker (default: **Bilder**), shown only on touch devices since it addresses an Android-specific picker quirk and isn't relevant on desktop:
  - **Bilder** uses the OS photo picker — quick to browse, but on Android the original file name is not preserved (the OS gives the browser an anonymized temporary name instead)
  - **Dateien** opens the regular file browser instead — slower to navigate, but keeps the real file name if you pick it from "Files"/"My Files" rather than "Google Photos"
- All selected images are converted to `.jpg`
- Adjustable JPEG quality (default: 75%) — changing the slider **after** images are already converted re-encodes them in place at the new quality, instead of only affecting images added afterward
- Optional renaming — only applied if "Rename files" is checked **and** the pattern field isn't empty; otherwise the original file name is kept (with `.jpg` as the extension, since the file is always converted)
  - a plain custom name, or
  - a pattern with placeholders (tap the **i** button in the app for the full legend), or
  - a ready-made preset picked from the dropdown (`DSC_$Y$M$D_$h$m$s`, `S23_$Y$M$D_$h$m$s`, `*_smalled`)

    | Placeholder | Meaning |
    |---|---|
    | `#` (repeatable) | Sequential number, padded to the number of `#` used (`#####` → `00042`) |
    | `*` | Original file name (without extension) |
    | `$Y` `$M` `$D` | Year / month / day the photo was taken (EXIF capture date), falling back to the file's last-modified date if no EXIF data is present |
    | `$h` `$m` `$s` | Hour / minute / second, same source |
    | `$Q` | The JPEG quality used for that image (e.g. `75`) |
    | `$R` | Saved resolution in pixels, e.g. `1920x1080` |
    | `$P` | Resize scale — the exact % in Percent mode, otherwise an approximate % derived from the actual pixel change |
    | `$S` | Resize preset name, e.g. `FullHD` or `Foto9x13` (empty outside Preset mode) |

    Example: `*_$Q` → `picture.png` at 75% quality becomes `picture_75.jpg`; `*_$R_$P` → a resized HD photo becomes `picture_1000x1000_48%.jpg`
- Names update live in the list as you change the rename pattern
- If a rename pattern produces the same name for multiple images (e.g. no `#` counter and two photos taken close together), **every** image in that group is numbered chronologically — `_1`, `_2`, ... inserted before `.jpg` — using millisecond-precision EXIF capture time where available
- Remove individual images from the list, or clear the whole list at once with **Remove all** (the app's other settings aren't affected — only the file list)
- You're warned before an accidental page reload or navigation throws away unsaved progress
- Download buttons ("Download all" / "Download all as ZIP") sit above the file list; images are converted **one at a time** using `createImageBitmap` and small real thumbnails, so large batches (hundreds of photos) don't run out of memory on mobile
- Dark mode by default, with a light mode toggle (moved into the ⋮-menu)
- Mobile-first layout — designed to be used from a phone
- 100% client-side: no backend, no analytics, no image ever leaves the device
- Original EXIF metadata (capture date, camera model, ISO, aperture, GPS, etc.) is preserved through the JPG conversion when the source file has it — re-encoding via `canvas` normally strips all of this
- Photo **orientation** is preserved correctly: the image is decoded with EXIF orientation already applied, and the copied-back orientation tag is reset to "normal" so viewers don't rotate an already-correct image a second time. The thumbnail embedded in the original's EXIF data is dropped (it would show the old sensor orientation, without resize or watermark), so file managers like Windows Explorer build the preview from the converted image itself; the pixel dimensions stored in the EXIF are updated to the output size
- **Export as other format** *(accessible via the ⋮-menu → "Export", closable with the × in its corner)*: convert the already-processed image (i.e. after the main Quality setting has been applied) to **PNG** or **WebP** instead
  - **PNG** supports a simple color-key transparency: pick a color and a tolerance (default 15%; 0% = exact match only)
  - **WebP** reuses the main Quality slider — no separate quality control
  - Available via "Export all" / "Export all as ZIP" — the regular "Save" / "Download all" buttons always produce JPG
- **Quality**, the export **transparent color**, and export **tolerance** are remembered across visits (`localStorage`); clicking a setting's label resets it to the default, shown with a small **•** marker whenever it's been changed from default
- Tapping an item in the list expands it in place, showing the full converted image at its full width (the panel's height adapts to the image, whatever its orientation) without needing to scroll — no popup/modal. Opening another item closes the previous one automatically
- The list shows each image's current (possibly resized) resolution alongside its file size
- **Resize images** *(optional, between Quality and Rename files)*:
  - Whenever every loaded image shares the same resolution (or only one is loaded), that size is shown live and used as the basis for every preview below
  - **Percent** mode: a 5%-step slider from 10–300%, plus a precise number field for exact values in between; shows the resulting pixel size live
  - **Pixel** mode: width and/or height, pre-filled as a placeholder with the current image size; with **Keep aspect ratio** on, editing one side live-updates the other to match; with it off and both sides filled, choose **Zoom (crop)** to fill the exact box, or **Fit** to keep the whole image with the border filled in **White**, **Anthracite**, or a **blurred** copy of the image itself
  - **Preset** mode: photo print sizes (with a selectable **DPI** — 72/150/300/600, default 300; these auto-orient to match the image, e.g. a 9×13 print becomes 13×9 for a landscape photo), pure aspect ratios (computed from each image's own resolution, always applied *after* rotation so a 16:9 choice stays 16:9), fixed video/screen sizes, and social media formats (fixed sizes keep their deliberate orientation) — all sharing the same Zoom/Fit + border-fill choice as Pixel mode
  - Changing any resize setting re-encodes already-converted images in place, same as Quality
- **Rotate, rename, and reset — per image**: expand an item in the list to rotate it 90° at a time (confirmed with a toast), give it a custom name — the same placeholders as the global Rename pattern work here too, except `#` — that's optionally **locked** so the "Rename files" pattern never overwrites it (typing a name auto-checks the lock, clearing it back out auto-unchecks it), compare against the untouched file with **Show original** (bottom-right of the expanded image, with an "Original" badge while active), or reset that one image's rotation and custom name back to default
- Renamed filenames — from both the global pattern and per-image custom names — are sanitized to characters valid on Windows, macOS, and Linux
- **Watermark** *(optional card under Rename files)*: load a **PNG, SVG, or WebP** by drag & drop or file selection (on phones always the plain file browser, since the photo picker has no SVGs) and stamp it onto every image
  - **Opacity** (default 50%), **Saturation** (100% = as loaded, 0% = black & white), and **Softness** (0–10%, softens the watermark's edges; default 0)
  - **Size** in percent (default 25%) or pixels — it applies to the watermark's longer side; percent values are relative to the image's *shorter* side, so a watermark looks equally big on portrait and landscape photos
  - **Position** via a 3×3 grid (default bottom right) and **Margin** in percent (default 3%) or pixels; the margin only applies on the edges the watermark is anchored to
  - Quality: the watermark is drawn as the very last step, once, onto the finished full-resolution image (after resize and rotation) — so the photo is never resampled again. SVGs are rasterized directly at their final pixel size and stay sharp; PNG/WebP are downscaled in halving steps, with a hint if one would have to be enlarged
  - A live mini-preview in the card shows the first loaded image (or a placeholder) with the watermark applied
  - The watermark file is remembered between visits (stored locally in the browser, never uploaded) and can be removed with the ×; its settings are remembered too, with the usual click-the-label-to-reset
  - Each image can opt out via **Watermark on this image** in its expanded panel. The PNG/WebP export includes the watermark automatically; **Show original** shows the image without it
  - SVGs are loaded as images, so scripts and external resources inside them are never executed. They need a `width`/`height` or a `viewBox`, and text inside should be converted to paths (fonts aren't loaded)
- **Reset all**: restores Quality, Resize, Rename, Watermark, and Export settings (and every image's rotation, per-image name override, and watermark switch) back to their defaults — the uploaded/converted images and the loaded watermark file stay, unlike **Remove all**
- **Compare images** *(experimental, only via the ⋮ menu → "Compare (experimental)")*: pick or drop two images (A and B) and compare them locally – **"Choose 2 images at once"** loads both in one dialog (sorted by name; a single file fills the next free slot), and either slot can be replaced later on its own:
  - **Checksums**: SHA-256 (plus SHA-1 / SHA-512) of each file and a **pixel hash** over the decoded pixels – equal pixel hashes with different file hashes mean only metadata or file structure differ. An optional **expected hash** field shows a green/red match (algorithm detected by length)
  - **Pixel differences** with adjustable tolerance (ignores JPEG recompression noise): red overlay, yellow boxes around a few changed regions, percentage of changed pixels, mean deviation and PSNR; widespread changes are reported instead of drawing many boxes. Different dimensions are compared by scaling B to A (marked as less precise); very different aspect ratios are not compared
  - **Auto-align** (on by default): B is automatically shifted and scaled onto A before comparing (coarse-to-fine search, shown in the result and in the swipe viewer), and a **position tolerance** (0–5 px) ignores differences that have a matching pixel nearby – so slightly shifted or re-rendered copies no longer show up as completely different
  - **Metadata**: JPEG segment inventory (EXIF, ICC, XMP, comments … with sizes) and a table of only the differing EXIF tags
  - **Extras**: perceptual similarity in %, A/B swipe slider, estimated JPEG quality, chroma subsampling, baseline/progressive, GPS presence
  - Images in the list that are byte-identical copies get a small "Identical file" hint
- **Saved sessions** *(collapsed area above the drop zone, appears after the first session is saved)*: the last 3 sessions are saved automatically – settings, original images, and per-image changes – and can be restored or deleted. Stored only in this browser (IndexedDB), never uploaded. Restoring replaces the current list and continues that session
- **GPS location check**: the expanded panel of each image shows whether the original file contained a GPS location (kept in the result) or not. Android may strip the location before the browser receives the image (photo picker, drag from the gallery)

## How it works

Each file is decoded with `createImageBitmap()` using `{ imageOrientation: 'from-image' }` (falling back to `FileReader` + `<img>` if unsupported) — both approaches normalize rotation according to the EXIF orientation tag, so the canvas always draws the image upright regardless of how the camera held it. The image is drawn onto an in-memory `<canvas>` at full resolution for the actual JPG output, and separately onto a small (≤64px) canvas for a lightweight list thumbnail — avoiding both the large base64 data URLs and the full-resolution `<img>` elements that previously caused out-of-memory crashes with large batches. Files are processed by a small worker pool of **3 at a time** — enough to be noticeably faster than one-by-one, without the memory/CPU overload that full parallel processing caused on mobile. Since re-encoding through `canvas.toBlob()` strips all metadata, the app separately reads the raw EXIF (APP1) segment out of the original JPEG's bytes and splices it back into the newly encoded file, resetting the copied Orientation tag to "normal" first (since the pixels are already upright), so capture date, camera info, etc. survive the compression without a double-rotation. The resulting JPGs are offered as direct downloads via `URL.createObjectURL`, or bundled into a ZIP by a small built-in ZIP writer (no external library, works offline; entries are stored without compression since JPG/PNG/WebP are already compressed). ZIP files are named `jpg75_YYYYMMDD-hhmmss.zip`.

## Files

- `index.html` — markup only
- `style.css` — all styling
- `app.js` — application logic
- `CHANGELOG.md` — version history
- `logo.png` — app logo shown in the header
- `netlify.toml` — base security headers for deployment (optional)
- `site.webmanifest` — PWA metadata (name, theme color, icons) used when someone adds the app to their home screen
- Push all files to the repo root; `index.html` links to `style.css`, `app.js`, `logo.png`, and the icon files below with relative paths

## Favicon

`index.html` already references all of these at the repo root:

- `favicon.ico`
- `favicon.webp`
- `favicon-16x16.png`
- `favicon-32x32.png`
- `apple-touch-icon.png` (180×180, used for "Add to Home Screen" on iOS)
- `android-chrome-192x192.png` / `android-chrome-512x512.png` (referenced by `site.webmanifest`, used for "Add to Home Screen" on Android)

If any file is missing, browsers just silently skip it — nothing breaks, you'll just see a generic icon until it's added.

## Browser support

Works in all modern browsers (Chrome, Safari, Firefox, Edge). Formats not natively decodable by the browser's `<img>`/`<canvas>` (e.g. HEIC in most non-Safari browsers) cannot be converted. EXIF capture-date reading for the `$Y`/`$M`/`$D`/`$h`/`$m`/`$s` placeholders, and EXIF preservation in general, only works on JPEG source files that contain EXIF metadata; other formats and JPEGs without EXIF data use the file's last-modified date instead and won't have metadata to preserve.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
