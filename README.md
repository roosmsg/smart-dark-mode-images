<div align="center">

# Smart Dark Mode Images

**Automatically adapt images to dark mode—without re-inverting images that are already dark.**

[![Obsidian 1.4.0+](https://img.shields.io/badge/Obsidian-1.4.0%2B-7C3AED?logo=obsidian&logoColor=white)](https://obsidian.md/)
[![Version 0.1.0](https://img.shields.io/badge/version-0.1.0-2563EB)](manifest.json)
[![Desktop and mobile](https://img.shields.io/badge/platform-desktop%20%7C%20mobile-0F766E)](#installation)
[![MIT License](https://img.shields.io/badge/license-MIT-EAB308)](LICENSE)

Smart Dark Mode Images applies a color-preserving luminance flip by default, then uses a tiny per-image sample to exempt images that already fit a dark theme.

</div>

> [!IMPORTANT]
> **Your image files are never modified.** Adaptation is a live visual filter. The plugin samples at most a 64 × 64 in-memory preview and stores only the resulting decision—no altered image copies are written to your vault.

## How it behaves

| Image | Smart mode |
| --- | --- |
| Mostly opaque and already dark | **Keep uninverted** |
| Light, transparent, colorful, or uncertain | **Adapt for dark mode** |
| Explicitly tagged `#no-invert` | **Keep uninverted** |
| Explicitly tagged `#invert` | **Always adapt** |

This deliberately simple rule avoids fragile attempts to distinguish photos, screenshots, scans, diagrams, and mixed-content images. A wrong photographic-category guess can produce unpredictable behavior; an already-dark check answers the important question directly: would inversion make this image brighter?

No tagging or setup is required. The filter is active only when Obsidian is using a dark theme, including **Adapt to system**.

## Highlights

| | |
| --- | --- |
| **Immediate adaptation** | Images are inverted from their first paint; a decision never arrives after a bright flash. |
| **Already-dark protection** | Mostly opaque images dominated by dark pixels remain uninverted. |
| **Color preservation** | A hue-preserving luminance matrix keeps colors recognizable while reversing brightness. |
| **Per-image control** | Override the automatic result directly from an embed. |
| **Image presentation** | Control image opacity, radius, light blending, grids, and PDF appearance. |
| **Lightweight operation** | Images are sampled once at thumbnail size; steady-state work is a static browser filter. |
| **No vault bloat** | No processed images, caches, or duplicates are written into the vault. |
| **Works across Obsidian** | Supports reading view, Live Preview, Canvas, hover popovers, and pop-out windows. |

## Installation

1. Open **Settings → Community plugins** in Obsidian.
2. Select **Browse** and search for **Smart Dark Mode Images**.
3. Select **Install**, then **Enable**.

## Per-image control

Override smart detection from an image source or alt text:

```md
![[image.png#no-invert]]
![[image.png#no-invert#no-dim]]
![[image.jpg#invert]]
![#no-invert](https://example.com/photo.png)
![alt](https://example.com/diagram.png#invert)
```

| Tag | Result |
| --- | --- |
| `#invert` | Always adapt the image in dark mode. |
| `#no-invert` or `#keep` | Keep the image uninverted and at full opacity. |
| `#no-dim` | Keep this image at full opacity; combine it with either automatic behavior or `#no-invert`. |
| Existing exact `dark` alt/alias token | Treat this as an already-dark image: keep it uninverted and at full opacity. |
| Existing `noclick` alt/alias token | Keep this image at full opacity without changing its inversion decision. |

Tags are recognized in URL fragments and alt text. For compatibility with other snippets, existing exact bare `dark` and `noclick` alt/alias tokens are respected as already-dark and no-fade signals respectively; this plugin never adds or modifies alt text. Other bare English words such as “keep” and “invert” are intentionally ignored so an ordinary caption or filename cannot trigger an override. The community conventions `#invert_B` and `invert_dark` are also recognized, including bare in the alias position (`![[image.png|invert_B]]`). If conflicting inversion tags are present, the keep tag wins.

## How detection works

Each image is drawn into a temporary canvas no larger than 64 × 64 pixels. Transparent pixels below roughly 5% opacity are ignored. An image is considered already dark only when:

- more than 90% of its sampled pixels are opaque; and
- at least half of those opaque pixels have luminance below 40%.

That image is kept uninverted and at full opacity. Every other readable image is adapted and uses the configured dark-mode opacity. An image that cannot be read or measured also uses the invert default, so a CORS failure cannot produce a bright flash. Rounded corners remain independent of this decision.

Cross-origin images are fetched through Obsidian's `requestUrl` only when browser security prevents direct sampling. They are decoded at thumbnail size, discarded immediately, and their decisions persist across sessions in the plugin settings. Multiple embeds of one URL share the same in-flight request. Use **Re-analyze images in open notes** to clear those decisions and sample again.

## How adaptation works

- Desktop uses a static SVG color matrix that flips luminance while retaining color identity.
- iOS uses the GPU-friendly `invert(1) hue-rotate(180deg)` equivalent to avoid expensive SVG reference-filter rendering in WKWebView.
- A `screen` blend over the active note background softens hard black rectangles and lets adapted images sit naturally on the theme surface.
- Pending images keep their layout but remain hidden for the brief classification step. Small batches are stamped before the next paint, and decoded images are stamped immediately on load. The image is revealed only with its final keep/invert state, preventing both dark negatives and light originals from flashing white.
- Inverted images fade to 70% by default in dark mode, transition over 0.25 seconds, and return to full opacity on hover. Automatically detected already-dark images and images with a `dark` alt token stay at full opacity; `#no-dim` and a `noclick` alt token opt out per image.
- Filters, fading, and blending are disabled when printing or exporting a note to PDF.

## Image grids

The grid controls use the `img-grid` CSS class. Add it to a note:

```yaml
---
cssclasses:
  - img-grid
---
```

Consecutive images are arranged in responsive columns. **Image grid crop** chooses between cropped cells and full-image containment; separate light and dark CSS colors can fill unused cell space.

## PDF viewer

PDF controls apply to Obsidian's built-in PDF viewer. They can remove page borders and shadows, invert black-on-white documents in dark mode, multiply-blend pages into light backgrounds, and adjust dark-mode page opacity. These viewer controls are separate from note-to-PDF export.

## Settings and commands

The classifier remains intentionally simple; the additional controls are presentation-only:

| Setting | Default | What it controls |
| --- | --- | --- |
| **Mode** | Smart | Smart protection, invert all untagged images, or off. |
| **Image opacity in dark mode** | 0.7 | Fades inverted images; already-dark images stay opaque and hover restores full opacity. |
| **Image radius** | 4 px | Rounded image corners. |
| **Blend images in light mode** | Off | Multiply-blends images into the light background. |
| **Image grid crop** | Crop to fit | Crop or contain images in `img-grid` cells. |
| **Image grid backgrounds** | Transparent | Separate light/dark CSS colors behind grid images. |
| **Per-image control** | — | Shows the available override tags. |
| **PDF page style** | Seamless | Seamless pages or page shadows. |
| **Invert PDFs in dark mode** | On | Adapts black-on-white PDFs. |
| **Blend PDFs in light mode** | On | Multiply-blends pages into light backgrounds. |
| **PDF opacity in dark mode** | 1.0 | Fades PDF pages in dark mode. |

Two commands are available from the Command Palette:

- **Toggle image inversion** — switch effects off or restore the previously active mode.
- **Re-analyze images in open notes** — discard cached decisions and sample open images again.

The automatic classifier, invert-by-default rule, and presentation controls are maintained as part of this plugin.

## License

Released under the [MIT License](LICENSE).
