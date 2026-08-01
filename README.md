<div align="center">

# Smart Dark Mode Images

**Automatically adapt bright images to dark mode—without changing images that already look right.**

[![Obsidian 1.4.0+](https://img.shields.io/badge/Obsidian-1.4.0%2B-7C3AED?logo=obsidian&logoColor=white)](https://obsidian.md/)
[![Version 0.1.0](https://img.shields.io/badge/version-0.1.0-2563EB)](manifest.json)
[![Desktop and mobile](https://img.shields.io/badge/platform-desktop%20%7C%20mobile-0F766E)](#installation)
[![MIT License](https://img.shields.io/badge/license-MIT-EAB308)](LICENSE)

The smart classifier decides what to do **for each image individually**. Bright images are adapted to your dark theme, already-dark images remain completely untouched, and images that should not be inverted keep their natural colors.

</div>

> [!IMPORTANT]
> **Your image files are never modified.** Inversion is a live visual filter. The classifier only samples a tiny in-memory preview and keeps the resulting decision—no altered copies are written to disk.

## One vault, different images, the right decision

Unlike a blanket CSS filter, Smart Dark Mode Images analyzes every image separately. You get comfortable light-background images without darkening images that already match your theme.

| Adapts for dark mode | Keeps uninverted |
| --- | --- |
| Bright, light-background images | Mostly opaque, already-dark images |
| Dark content on a transparent background | Images with rich natural colors |
| Images confidently identified as needing adjustment | Anything the classifier is unsure about |

Already-dark images receive **no inversion and no dimming**. Other images kept uninverted can be softened with the configurable brightness cap.

**No tagging or manual setup is required.** Install the plugin, enable it, and smart detection works automatically whenever Obsidian switches to a dark theme.

## More highlights

| | |
| --- | --- |
| **Smart detection** | Decides automatically whether each image needs to be adapted. |
| **Theme-aware output** | Maps bright backgrounds toward your theme's background instead of producing a harsh, pitch-black negative. |
| **Color preservation** | Uses a hue-preserving luminance flip to keep image colors recognizable. |
| **Already-dark protection** | Leaves mostly opaque, already-dark images completely unchanged. |
| **Per-image control** | Override inversion and dimming directly from an embed. |
| **Works across Obsidian** | Supports reading view, Live Preview, Canvas, and hover popovers. |
| **Safe by default** | Leaves an image unchanged whenever the classifier is unsure. |

## Installation

1. Open **Settings → Community plugins** in Obsidian.
2. Select **Browse** and search for **Smart Dark Mode Images**.
3. Select **Install**, then **Enable**.

The plugin follows Obsidian's current appearance, including **Adapt to system**. It only applies image filters while the active theme is dark.

## Per-image control

Automatic detection can be overridden from any embed:

```md
![[image.png#no-invert]]
![[image.png#no-invert#no-dim]]
![[image.jpg#invert]]
![alt](https://…/img.png#invert)
```

| Override alt | Result |
| --- | --- |
| `#invert` | Always invert the image. |
| `#no-invert` | Keep the image uninverted and apply the brightness cap, unless it is already dark. |
| `#no-dim` | Prevent dimming without changing the automatic inversion decision. |
| `#no-invert#no-dim` | Apply neither inversion nor dimming. |

Override alts work in either the URL fragment or alt text. The community conventions `#invert_B` and `invert_dark` are recognized too.

## How smart detection works

Each image is classified once from a downscaled sample of at most 64 × 64 pixels. The rules run in this order:

| Image characteristics | Action | Why |
| --- | :---: | --- |
| Mostly opaque and already dark | **Keep unchanged** | The image already fits a dark theme; it is neither inverted nor dimmed. |
| Dark content on transparency | **Invert** | Keeps the image visible against a dark background. |
| Mostly light and unsaturated | **Invert** | Reduces glare from a bright image. |
| Near-white background with flat regions | **Invert** | Adapts a clearly light image to the theme. |
| Flat image with a light border and small palette | **Invert** | Indicates a high-confidence light composition. |
| Saturated midtones or a rich palette | **Keep; optionally dim** | Preserves the image's natural colors while allowing a softer brightness. |
| Strong light/dark contrast with a light background | **Invert** | Improves the image's dark-mode appearance. |
| Ambiguous | **Keep unchanged** | The fail-safe choice avoids damaging the viewing experience. |

Cross-origin images that cannot be sampled directly are fetched through Obsidian's CORS-free `requestUrl`, classified in memory, and discarded.

Enable **Log decisions** in the plugin settings to inspect each verdict, matched rule, and pixel statistics in the developer console (`Ctrl+Shift+I`).

## How inversion works

- **Preserve colors** uses a hue-preserving luminance matrix. It avoids the uneven colors produced by the common `invert(1) hue-rotate(180deg)` trick.
- **Match theme background** derives the inversion strength from `--background-primary`, so white lands close to the page color rather than pure black.
- **Dim bright images** applies a configurable brightness cap to eligible images that remain uninverted. Already-dark and ambiguous images are never dimmed automatically.
- Filters are disabled when printing or exporting to PDF.

## Settings

| Setting | Default | What it controls |
| --- | --- | --- |
| **Mode** | Smart | Smart detection, all images, or off. |
| **Match theme background** | On | Derives inversion strength from the active theme. |
| **Inversion strength** | 90% | Manual strength when theme matching is disabled. |
| **Preserve colors** | On | Hue-preserving flip instead of a plain negative. |
| **Dim bright images** | 95% | Brightness cap for eligible images and `#no-invert`; already-dark images are excluded and `#no-dim` skips it. |
| **Unreadable images** | Leave as-is | Fallback when pixels cannot be analyzed. |
| **Light background threshold** | 58% | How light an unsaturated image must be before it is adapted. |
| **Saturation threshold** | 18% | Saturated-pixel share at which an image is treated as colorful. |
| **Log decisions** | Off | Logs verdicts, rules, and pixel statistics to the developer console. |

Two commands are available from the Command Palette:

- **Toggle image inversion** — switch image effects off or back on. Assign a shortcut in **Settings → Hotkeys** if desired; none is assigned by default.
- **Re-analyze images in open notes**

## License

Released under the [MIT License](LICENSE).
