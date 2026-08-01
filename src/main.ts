import { Plugin, PluginSettingTab, Setting, requestUrl } from "obsidian";
import { classifyImage, classifySource, PixelStats, Verdict } from "./classify";

type Mode = "off" | "smart" | "all";

/** What gets stamped on an image: inverted, dimmed, or kept untouched. */
type Stamp = Verdict | "dim";

interface ImageOverride {
  verdict: Verdict | null;
  noDim: boolean;
}

interface DarkModeImagesSettings {
  mode: Mode;
  /** Derive inversion strength from the theme background so inverted white
   *  matches the page color instead of going stark black. */
  autoStrength: boolean;
  /** Manual inversion strength in percent (100 = full negative). */
  strength: number;
  /** Re-rotate hues 180° after inverting so colors keep their identity. */
  preserveHue: boolean;
  /** Brightness (percent) applied to images that are NOT inverted; 100 = untouched. */
  dimKept: number;
  /** What to do with images whose pixels cannot be read (remote/CORS). */
  unreadableFallback: Verdict;
  lightBgThreshold: number;
  saturatedThreshold: number;
  /** Log every classification decision to the developer console. */
  debug: boolean;
}

const DEFAULT_SETTINGS: DarkModeImagesSettings = {
  mode: "smart",
  autoStrength: true,
  strength: 90,
  preserveHue: true,
  dimKept: 95,
  unreadableFallback: "keep",
  lightBgThreshold: 0.58,
  saturatedThreshold: 0.18,
  debug: false,
};

/** Containers whose images we manage. Deliberately excludes settings dialogs,
 *  theme-store previews and other app chrome. */
const SCOPE =
  ".markdown-preview-view, .markdown-source-view, .canvas-wrapper, .hover-popover";

/** Tokens recognised in alt text or in a `#fragment` of the embed source.
 *  invert_b / invert_dark keep compatibility with the community CSS
 *  snippets from the "auto-adaptive images" forum thread. */
const KEEP_TOKENS = new Set(["no-invert", "noinvert", "no_invert", "keep"]);
const INVERT_TOKENS = new Set(["invert", "invert_b", "invert_dark"]);
const NO_DIM_TOKENS = new Set(["no-dim", "nodim", "no_dim"]);

export default class DarkModeImagesPlugin extends Plugin {
  settings: DarkModeImagesSettings = { ...DEFAULT_SETTINGS };

  private observer: MutationObserver | null = null;
  private cache = new Map<string, Stamp>();
  private alreadyDark = new Set<string>();
  private pendingRemote = new Set<string>();
  private retried = new WeakSet<HTMLImageElement>();
  private queue: HTMLImageElement[] = [];
  private idleHandle: number | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new DarkModeImagesSettingTab(this));
    this.injectSvgFilter();

    this.addCommand({
      id: "toggle",
      name: "Toggle image inversion",
      callback: () => {
        this.settings.mode = this.settings.mode === "off" ? "smart" : "off";
        void this.saveSettings();
      },
    });

    this.addCommand({
      id: "reanalyze",
      name: "Re-analyze images in open notes",
      callback: () => this.restamp(),
    });

    this.applySettings();
    this.startObserver();
    // Theme/appearance changes move --background-primary; re-derive strength.
    this.registerEvent(this.app.workspace.on("css-change", () => this.applySettings()));
    // Obsidian may load us after notes are already rendered.
    this.app.workspace.onLayoutReady(() => this.processAll());
  }

  onunload() {
    this.observer?.disconnect();
    if (this.idleHandle !== null) window.cancelIdleCallback?.(this.idleHandle);
    document.body.classList.remove("dmi-on", "dmi-hue");
    document.body.style.removeProperty("--dmi-strength");
    document.body.style.removeProperty("--dmi-dim");
    for (const el of Array.from(document.body.querySelectorAll("img[data-dmi]"))) {
      el.removeAttribute("data-dmi");
      delete (el as HTMLImageElement).dataset.dmiSrc;
    }
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applySettings();
    this.restamp();
  }

  /** Push settings into body classes / CSS variables; styles.css does the rest. */
  applySettings() {
    const body = document.body;
    body.classList.toggle("dmi-on", this.settings.mode !== "off");
    body.classList.toggle("dmi-hue", this.settings.preserveHue);
    const strength = this.settings.autoStrength
      ? this.themeMatchedStrength()
      : this.settings.strength;
    body.style.setProperty("--dmi-strength", String(strength));
    body.style.setProperty("--dmi-dim", String(this.settings.dimKept));
  }

  /**
   * Hue-preserving luminance flip using an equal-weight luma matrix with
   * sRGB interpolation. Grays map to exactly 1-v while hues keep their
   * identity, avoiding the uneven output of
   * `invert(1) hue-rotate(180deg)`.
   */
  private injectSvgFilter() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.style.position = "absolute";
    const filter = document.createElementNS(NS, "filter");
    filter.id = "dmi-invert-nhue";
    filter.setAttribute("color-interpolation-filters", "sRGB");
    const matrix = document.createElementNS(NS, "feColorMatrix");
    matrix.setAttribute("type", "matrix");
    matrix.setAttribute(
      "values",
      " 0.333 -0.667 -0.667 0 1 " +
        "-0.667  0.333 -0.667 0 1 " +
        "-0.667 -0.667  0.333 0 1 " +
        " 0      0      0     1 0"
    );
    filter.appendChild(matrix);
    svg.appendChild(filter);
    document.body.appendChild(svg);
    this.register(() => svg.remove());
  }

  /**
   * Inversion strength that maps pure white onto the theme's background
   * luminance: invert(k) sends white to 1-k, so k = 1 - bgLum makes an
   * inverted white page blend into the theme instead of going pitch black.
   */
  private themeMatchedStrength(): number {
    const probe = document.body.createDiv();
    probe.style.backgroundColor = "var(--background-primary)";
    probe.style.display = "none";
    const rgb = getComputedStyle(probe).backgroundColor.match(/\d+(\.\d+)?/g);
    probe.remove();
    if (!rgb || rgb.length < 3) return 90;
    const [r, g, b] = rgb.map(Number);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return Math.min(100, Math.max(60, Math.round((1 - lum) * 100)));
  }

  /** Clear verdicts and re-run classification for everything on screen. */
  restamp() {
    this.cache.clear();
    this.alreadyDark.clear();
    for (const el of Array.from(document.body.querySelectorAll("img[data-dmi]"))) {
      el.removeAttribute("data-dmi");
      delete (el as HTMLImageElement).dataset.dmiSrc;
    }
    this.processAll();
  }

  private startObserver() {
    this.observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes") {
          if (m.target instanceof HTMLImageElement) this.enqueue(m.target);
          continue;
        }
        for (const node of Array.from(m.addedNodes)) {
          if (!(node instanceof HTMLElement)) continue;
          if (node instanceof HTMLImageElement) this.enqueue(node);
          else {
            for (const img of Array.from(node.querySelectorAll("img"))) {
              this.enqueue(img);
            }
          }
        }
      }
    });
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
    this.register(() => this.observer?.disconnect());
  }

  private processAll() {
    for (const img of Array.from(document.body.querySelectorAll("img"))) {
      this.enqueue(img);
    }
  }

  private enqueue(img: HTMLImageElement) {
    if (this.settings.mode === "off") return;
    if (!img.closest(SCOPE)) return;
    if (img.dataset.dmiSrc === img.src && img.dataset.dmi) return; // already stamped
    this.queue.push(img);
    this.scheduleDrain();
  }

  private scheduleDrain() {
    if (this.idleHandle !== null) return;
    const drain = () => {
      this.idleHandle = null;
      const batch = this.queue.splice(0, 20);
      for (const img of batch) this.process(img);
      if (this.queue.length > 0) this.scheduleDrain();
    };
    this.idleHandle = window.requestIdleCallback
      ? window.requestIdleCallback(drain, { timeout: 500 })
      : (window.setTimeout(drain, 50) as unknown as number);
  }

  private process(img: HTMLImageElement) {
    if (!img.isConnected) return;
    img.dataset.dmiSrc = img.src;

    const override = this.overrideFor(img);
    if (override.verdict === "invert") {
      img.dataset.dmi = "invert";
      return;
    }
    if (override.verdict === "keep" && override.noDim) {
      img.dataset.dmi = "keep";
      return;
    }
    const forceKeep = override.verdict === "keep";

    if (this.settings.mode === "all" && !forceKeep) {
      img.dataset.dmi = "invert";
      return;
    }

    // Smart mode: wait for pixels, then classify.
    if (!img.complete) {
      img.addEventListener("load", () => this.enqueue(img), { once: true });
      return;
    }

    // SVGs without intrinsic dimensions report naturalWidth 0 even when
    // loaded; fall back to layout size. If the image has no size at all yet
    // (not laid out), retry once shortly instead of dead-ending.
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) {
      if (!this.retried.has(img)) {
        this.retried.add(img);
        window.setTimeout(() => {
          delete img.dataset.dmiSrc;
          this.enqueue(img);
        }, 300);
      } else {
        const fallbackStamp = this.applyOverride(
          this.settings.unreadableFallback,
          img.src.split("#")[0],
          override
        );
        this.debugLog(
          img.src,
          "unmeasurable",
          null,
          fallbackStamp === "invert" ? "invert" : "keep"
        );
        img.dataset.dmi = fallbackStamp;
      }
      return;
    }

    // Tiny images (icons, favicons) are not worth touching.
    if (w < 8 || h < 8) {
      img.dataset.dmi = "keep";
      return;
    }

    const cacheKey = img.src.split("#")[0];
    const cached = this.cache.get(cacheKey);
    if (cached) {
      img.dataset.dmi = this.applyOverride(cached, cacheKey, override);
      return;
    }

    const result = classifyImage(img, this.classifyOpts());
    this.trackAlreadyDark(cacheKey, result);

    if (result === null && /^https?:/i.test(img.src)) {
      // Cross-origin image tainted the canvas. Obsidian's requestUrl has no
      // CORS restrictions: fetch the bytes, decode, classify, discard. Only
      // the verdict is kept — never a copy of the image.
      img.dataset.dmi = this.applyOverride(
        this.settings.unreadableFallback,
        cacheKey,
        override
      );
      void this.analyzeRemote(img, cacheKey, override);
      return;
    }

    const loggedVerdict = forceKeep
      ? "keep"
      : result?.verdict ?? this.settings.unreadableFallback;
    this.debugLog(
      img.src,
      forceKeep
        ? `no-invert:${result?.rule ?? "unreadable-fallback"}`
        : result?.rule ?? "unreadable-fallback",
      result?.stats ?? null,
      loggedVerdict
    );
    this.remember(cacheKey, this.stampFor(result), img, override);
  }

  /** Only confident bright keeps are dimmable; already-dark and ambiguous
   *  images stay fully untouched. */
  private stampFor(result: { verdict: Verdict; rule: string } | null): Stamp {
    if (!result) return this.settings.unreadableFallback;
    if (result.verdict === "keep" && result.rule === "photo-like") return "dim";
    return result.verdict;
  }

  private applyNoDim(stamp: Stamp, noDim: boolean): Stamp {
    return noDim && stamp === "dim" ? "keep" : stamp;
  }

  private applyOverride(
    stamp: Stamp,
    cacheKey: string,
    override: ImageOverride
  ): Stamp {
    if (override.verdict === "invert") return "invert";
    if (override.verdict === "keep") {
      return override.noDim || this.alreadyDark.has(cacheKey) ? "keep" : "dim";
    }
    return this.applyNoDim(stamp, override.noDim);
  }

  private trackAlreadyDark(
    cacheKey: string,
    result: { rule: string } | null
  ) {
    if (result?.rule === "already-dark") this.alreadyDark.add(cacheKey);
    else this.alreadyDark.delete(cacheKey);
  }

  private debugLog(src: string, rule: string, stats: PixelStats | null, verdict: Verdict) {
    if (!this.settings.debug) return;
    const rounded = stats
      ? Object.fromEntries(
          Object.entries(stats).map(([k, v]) => [k, Math.round((v as number) * 100) / 100])
        )
      : {};
    console.log(`[smart-dark-mode-images] ${verdict} (${rule})`, src, rounded);
  }

  private classifyOpts() {
    return {
      lightBgThreshold: this.settings.lightBgThreshold,
      saturatedThreshold: this.settings.saturatedThreshold,
    };
  }

  private remember(
    cacheKey: string,
    stamp: Stamp,
    img: HTMLImageElement,
    override: ImageOverride
  ) {
    if (this.cache.size > 500) {
      this.cache.clear();
      this.alreadyDark.clear();
    }
    this.cache.set(cacheKey, stamp);
    if (img.isConnected) {
      img.dataset.dmi = this.applyOverride(stamp, cacheKey, override);
    }
  }

  private async analyzeRemote(
    img: HTMLImageElement,
    cacheKey: string,
    override: ImageOverride
  ) {
    if (this.pendingRemote.has(cacheKey)) return;
    this.pendingRemote.add(cacheKey);
    try {
      const resp = await requestUrl({ url: cacheKey });
      const type = resp.headers?.["content-type"] ?? "image/png";
      const bitmap = await createImageBitmap(new Blob([resp.arrayBuffer], { type }));
      const result = classifySource(bitmap, bitmap.width, bitmap.height, this.classifyOpts());
      bitmap.close();
      this.trackAlreadyDark(cacheKey, result);
      const forceKeep = override.verdict === "keep";
      this.debugLog(
        cacheKey,
        forceKeep
          ? `no-invert:${result?.rule ?? "remote-unreadable"}`
          : result?.rule ?? "remote-unreadable",
        result?.stats ?? null,
        forceKeep ? "keep" : result?.verdict ?? this.settings.unreadableFallback
      );
      this.remember(cacheKey, this.stampFor(result), img, override);
    } catch {
      this.debugLog(cacheKey, "remote-fetch-failed", null, this.settings.unreadableFallback);
      this.remember(cacheKey, this.settings.unreadableFallback, img, override);
    } finally {
      this.pendingRemote.delete(cacheKey);
    }
  }

  /** Explicit per-image control via override alts in alt text or fragments. */
  private overrideFor(img: HTMLImageElement): ImageOverride {
    const sources = [
      img.getAttribute("alt") ?? "",
      img.getAttribute("src") ?? "",
      img.closest(".internal-embed")?.getAttribute("src") ?? "",
      img.closest(".internal-embed")?.getAttribute("alt") ?? "",
    ];
    let keep = false;
    let invert = false;
    let noDim = false;
    for (const s of sources) {
      const tokens = s.toLowerCase().split(/[#|,\s]+/);
      for (const t of tokens) {
        if (KEEP_TOKENS.has(t)) keep = true;
        if (INVERT_TOKENS.has(t)) invert = true;
        if (NO_DIM_TOKENS.has(t)) noDim = true;
      }
    }
    return { verdict: keep ? "keep" : invert ? "invert" : null, noDim };
  }
}

class DarkModeImagesSettingTab extends PluginSettingTab {
  constructor(private plugin: DarkModeImagesPlugin) {
    super(plugin.app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Mode")
      .setDesc(
        "Smart: analyze each image and invert only images that need adapting. " +
          "All: invert every image. Inversion only ever applies while dark mode is active."
      )
      .addDropdown((d) =>
        d
          .addOptions({ smart: "Smart (recommended)", all: "All images", off: "Off" })
          .setValue(this.plugin.settings.mode)
          .onChange(async (v) => {
            this.plugin.settings.mode = v as Mode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Match theme background")
      .setDesc(
        "Derive inversion strength from the theme's background color, so inverted " +
          "white areas blend into the page instead of turning pitch black."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoStrength).onChange(async (v) => {
          this.plugin.settings.autoStrength = v;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (!this.plugin.settings.autoStrength) {
      new Setting(containerEl)
        .setName("Inversion strength")
        .setDesc(
          "100% is a full negative. Slightly lower values (85–95%) reduce glare from " +
            "pure-white areas and look less harsh."
        )
        .addSlider((s) =>
          s
            .setLimits(50, 100, 5)
            .setValue(this.plugin.settings.strength)
            .setDynamicTooltip()
            .onChange(async (v) => {
              this.plugin.settings.strength = v;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("Preserve colors")
      .setDesc(
        "Flip only brightness and keep hues, so reds stay red and blues stay blue " +
          "instead of flipping to their complements."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.preserveHue).onChange(async (v) => {
          this.plugin.settings.preserveHue = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Dim bright images")
      .setDesc(
        "Brightness for images kept by smart detection or #no-invert. 100% leaves " +
          "them untouched; lower values soften them against a dark background. " +
          "Use #no-dim to keep an individual image at its original brightness."
      )
      .addSlider((s) =>
        s
          .setLimits(40, 100, 5)
          .setValue(this.plugin.settings.dimKept)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.dimKept = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Unreadable images")
      .setDesc(
        "Some remote images cannot be analyzed (cross-origin restrictions). " +
          "Choose what smart mode should do with them."
      )
      .addDropdown((d) =>
        d
          .addOptions({ keep: "Leave as-is", invert: "Invert" })
          .setValue(this.plugin.settings.unreadableFallback)
          .onChange(async (v) => {
            this.plugin.settings.unreadableFallback = v as Verdict;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("Per-image control").setDesc(
      "Add #invert or #no-invert to override the automatic decision. #no-invert " +
        "uses the dimming level; add #no-dim to keep the original brightness."
    );

    new Setting(containerEl).setName("Fine-tuning").setHeading();

    new Setting(containerEl)
      .setName("Light background threshold")
      .setDesc(
        "How much of an image must be light before an unsaturated image counts " +
          "as having a light background and gets inverted. Lower = invert more."
      )
      .addSlider((s) =>
        s
          .setLimits(30, 80, 5)
          .setValue(Math.round(this.plugin.settings.lightBgThreshold * 100))
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.lightBgThreshold = v / 100;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Saturation threshold")
      .setDesc(
        "Share of saturated pixels at which an image counts as colorful and is kept " +
          "un-inverted. Raise this to keep fewer colorful images; lower it if colorful " +
          "images get inverted."
      )
      .addSlider((s) =>
        s
          .setLimits(5, 40, 1)
          .setValue(Math.round(this.plugin.settings.saturatedThreshold * 100))
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.saturatedThreshold = v / 100;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Log decisions")
      .setDesc(
        "Write every classification (verdict, rule, pixel statistics) to the developer " +
          "console (Ctrl+Shift+I) to understand why an image was or wasn't inverted."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.debug).onChange(async (v) => {
          this.plugin.settings.debug = v;
          await this.plugin.saveSettings();
        })
      );
  }
}
