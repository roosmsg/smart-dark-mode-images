import {
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceWindow,
  requestUrl,
} from "obsidian";
import { classifyImage, classifySource, Verdict } from "./classify";

type Mode = "off" | "smart" | "all";
type ActiveMode = Exclude<Mode, "off">;
type ImageGridFit = "cover" | "contain";
type PdfPageStyle = "seamless" | "shadows";

interface ImageOverride {
  verdict: Verdict | null;
  noDim: boolean;
}

interface DarkModeImagesSettings {
  mode: Mode;
  /** Mode restored by the toggle command after switching the plugin off. */
  lastActiveMode: ActiveMode;
  /** Image opacity in dark mode (1 = fully opaque). */
  imageOpacity: number;
  /** Rounded corners for note images, in pixels. */
  imageRadius: number;
  /** Multiply-blend note images into light theme backgrounds. */
  imageBlendLight: boolean;
  /** How images in an img-grid note fill their cells. */
  imageGridFit: ImageGridFit;
  imageGridBackgroundLight: string;
  imageGridBackgroundDark: string;
  /** PDF presentation controls. */
  pdfPageStyle: PdfPageStyle;
  pdfInvertDark: boolean;
  pdfBlendLight: boolean;
  pdfDarkOpacity: number;
  /** Persist remote decisions so each URL is downloaded for analysis once. */
  remoteVerdicts: Record<string, Verdict>;
}

const DEFAULT_SETTINGS: DarkModeImagesSettings = {
  mode: "smart",
  lastActiveMode: "smart",
  imageOpacity: 0.7,
  imageRadius: 4,
  imageBlendLight: false,
  imageGridFit: "cover",
  imageGridBackgroundLight: "transparent",
  imageGridBackgroundDark: "transparent",
  pdfPageStyle: "seamless",
  pdfInvertDark: true,
  pdfBlendLight: true,
  pdfDarkOpacity: 1,
  remoteVerdicts: {},
};

const REMOTE_VERDICTS_MAX = 300;
const MEMORY_CACHE_MAX = 500;

/**
 * Static hue-preserving luminance flip. A neutral input v maps to 1-v,
 * while the dominant channel remains dominant. The matrix is fixed: the
 * screen blend in styles.css lets the result pick up its actual backdrop.
 */
const HUE_MATRIX = [
  "0.333333 -0.666667 -0.666666 0 1",
  "-0.666666 0.333333 -0.666667 0 1",
  "-0.666667 -0.666666 0.333333 0 1",
  "0 0 0 1 0",
].join(" ");

/** instanceof fails across realms, such as an Obsidian pop-out window. */
function isImgElement(node: Node): node is HTMLImageElement {
  return node.nodeType === 1 && (node as Element).tagName === "IMG";
}

function isMode(value: unknown): value is Mode {
  return value === "off" || value === "smart" || value === "all";
}

function isActiveMode(value: unknown): value is ActiveMode {
  return value === "smart" || value === "all";
}

function isImageGridFit(value: unknown): value is ImageGridFit {
  return value === "cover" || value === "contain";
}

function isPdfPageStyle(value: unknown): value is PdfPageStyle {
  return value === "seamless" || value === "shadows";
}

function validCssColor(value: unknown, fallback: string): string {
  return typeof value === "string" && CSS.supports("color", value) ? value : fallback;
}

/** Containers whose note images we manage. App chrome is excluded. */
const SCOPE =
  ".markdown-preview-view, .markdown-source-view, .canvas-wrapper, .hover-popover";

/**
 * Explicit #tags are accepted in alt text and source fragments. Bare forms
 * are limited to tokens that cannot be mistaken for normal English. This
 * prevents captions such as "How to invert a tree" from changing behavior.
 */
const TAGGED_KEEP = new Set(["no-invert", "noinvert", "no_invert", "keep"]);
const TAGGED_INVERT = new Set(["invert", "invert_b", "invert_dark"]);
const BARE_KEEP = new Set(["no-invert", "noinvert", "no_invert"]);
const BARE_INVERT = new Set(["invert_b", "invert_dark"]);
const BARE_ALT_KEEP = new Set(["dark"]);
const TAGGED_NO_DIM = new Set(["no-dim", "nodim", "no_dim", "noclick"]);
const BARE_NO_DIM = new Set(["no-dim", "nodim", "no_dim", "noclick"]);
const TAG_RE = /#([a-z0-9_-]+)/gi;

export default class DarkModeImagesPlugin extends Plugin {
  settings: DarkModeImagesSettings = { ...DEFAULT_SETTINGS };

  /** Base classifier decisions; overrides and mode are applied per embed. */
  private cache = new Map<string, Verdict>();
  private remoteWaiters = new Map<string, Set<HTMLImageElement>>();
  private remoteGeneration = 0;
  /** Serialize data.json writes so concurrent remote results cannot race. */
  private saveChain: Promise<void> = Promise.resolve();

  private queue: HTMLImageElement[] = [];
  private queued = new WeakSet<HTMLImageElement>();
  private waitingForLoad = new WeakSet<HTMLImageElement>();
  private retried = new WeakSet<HTMLImageElement>();
  private frameHandle: number | null = null;
  private disposed = false;

  /** The main document plus every open pop-out document. */
  private docs = new Set<Document>();
  private observers = new Map<Document, MutationObserver>();
  private svgs = new Map<Document, SVGSVGElement>();

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new DarkModeImagesSettingTab(this));
    this.attachDocument(document);

    this.addCommand({
      id: "toggle",
      name: "Toggle image inversion",
      callback: () => {
        if (this.settings.mode === "off") {
          this.settings.mode = this.settings.lastActiveMode;
        } else {
          this.settings.lastActiveMode = this.settings.mode;
          this.settings.mode = "off";
        }
        void this.saveMode();
      },
    });

    this.addCommand({
      id: "reanalyze",
      name: "Re-analyze images in open notes",
      callback: () => this.restamp(true),
    });

    this.applySettings();

    this.registerEvent(
      this.app.workspace.on("window-open", (workspaceWindow: WorkspaceWindow) => {
        this.attachDocument(workspaceWindow.doc);
        this.applySettings();
        this.processAll();
      })
    );
    this.registerEvent(
      this.app.workspace.on("window-close", (workspaceWindow: WorkspaceWindow) => {
        this.detachDocument(workspaceWindow.doc);
      })
    );

    // Obsidian may load the plugin after notes and pop-outs already exist.
    this.app.workspace.onLayoutReady(() => {
      if (this.disposed) return;
      this.app.workspace.iterateAllLeaves((leaf) => {
        const doc = leaf.view.containerEl.ownerDocument;
        if (!this.docs.has(doc)) this.attachDocument(doc);
      });
      this.applySettings();
      this.processAll();
    });
  }

  onunload() {
    this.disposed = true;
    this.cancelDrain();
    this.queue.length = 0;
    this.remoteGeneration++;
    this.remoteWaiters.clear();

    for (const doc of Array.from(this.docs)) this.detachDocument(doc);
  }

  private async loadSettings() {
    const raw = ((await this.loadData()) ?? {}) as Partial<DarkModeImagesSettings> & {
      /** Development-build key retained only for one-time migration. */
      dimKept?: unknown;
    };
    const mode = isMode(raw.mode) ? raw.mode : DEFAULT_SETTINGS.mode;
    const lastActiveMode = isActiveMode(raw.lastActiveMode)
      ? raw.lastActiveMode
      : mode === "off"
        ? DEFAULT_SETTINGS.lastActiveMode
        : mode;

    // Older development builds stored objects such as {s:"dim"}. Ignore
    // those stale classifier results so the new rule analyzes them afresh.
    const remoteVerdicts: Record<string, Verdict> = {};
    if (raw.remoteVerdicts && typeof raw.remoteVerdicts === "object") {
      for (const [url, verdict] of Object.entries(raw.remoteVerdicts)) {
        if (verdict === "invert" || verdict === "keep") {
          remoteVerdicts[url] = verdict;
        }
      }
    }

    this.settings = {
      mode,
      lastActiveMode,
      imageOpacity:
        typeof raw.imageOpacity === "number" &&
        raw.imageOpacity >= 0.25 &&
        raw.imageOpacity <= 1
          ? raw.imageOpacity
          : typeof raw.dimKept === "number" && raw.dimKept >= 25 && raw.dimKept <= 100
            ? raw.dimKept / 100
            : DEFAULT_SETTINGS.imageOpacity,
      imageRadius:
        typeof raw.imageRadius === "number" && raw.imageRadius >= 0 && raw.imageRadius <= 16
          ? raw.imageRadius
          : DEFAULT_SETTINGS.imageRadius,
      imageBlendLight: raw.imageBlendLight === true,
      imageGridFit: isImageGridFit(raw.imageGridFit)
        ? raw.imageGridFit
        : DEFAULT_SETTINGS.imageGridFit,
      imageGridBackgroundLight: validCssColor(
        raw.imageGridBackgroundLight,
        DEFAULT_SETTINGS.imageGridBackgroundLight
      ),
      imageGridBackgroundDark: validCssColor(
        raw.imageGridBackgroundDark,
        DEFAULT_SETTINGS.imageGridBackgroundDark
      ),
      pdfPageStyle: isPdfPageStyle(raw.pdfPageStyle)
        ? raw.pdfPageStyle
        : DEFAULT_SETTINGS.pdfPageStyle,
      pdfInvertDark: raw.pdfInvertDark !== false,
      pdfBlendLight: raw.pdfBlendLight !== false,
      pdfDarkOpacity:
        typeof raw.pdfDarkOpacity === "number" &&
        raw.pdfDarkOpacity >= 0.25 &&
        raw.pdfDarkOpacity <= 1
          ? raw.pdfDarkOpacity
          : DEFAULT_SETTINGS.pdfDarkOpacity,
      remoteVerdicts,
    };
    this.seedRemoteCache();
  }

  /** Persist a mode change, apply CSS state, and update open embeds. */
  async saveMode() {
    await this.queueSave();
    this.applySettings();
    this.restamp(false);
  }

  /** Persist a setting that does not change existing decisions. */
  async savePresentation() {
    await this.queueSave();
    this.applySettings();
  }

  private queueSave(): Promise<void> {
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(() => this.saveData(this.settings));
    return this.saveChain;
  }

  private attachDocument(doc: Document) {
    if (this.docs.has(doc) || !doc.body) return;
    this.docs.add(doc);
    this.injectSvgFilter(doc);
    this.startObserver(doc);
  }

  private detachDocument(doc: Document) {
    this.observers.get(doc)?.disconnect();
    this.observers.delete(doc);
    this.svgs.get(doc)?.remove();
    this.svgs.delete(doc);

    if (doc.body) {
      doc.body.classList.remove(
        "dmi-on",
        "dmi-native-filter",
        "dmi-image-blend-light",
        "dmi-pdf-shadows",
        "dmi-pdf-invert-dark",
        "dmi-pdf-blend-light"
      );
      for (const property of [
        "--dmi-image-opacity",
        "--dmi-image-radius",
        "--dmi-image-grid-fit",
        "--dmi-image-grid-background-light",
        "--dmi-image-grid-background-dark",
        "--dmi-pdf-dark-opacity",
      ]) {
        doc.body.style.removeProperty(property);
      }
      for (const image of Array.from(
        doc.body.querySelectorAll<HTMLImageElement>("img[data-dmi]")
      )) {
        this.clearStamp(image);
      }
    }
    this.docs.delete(doc);
  }

  /** Apply the two global presentation states to every managed document. */
  private applySettings() {
    for (const doc of this.docs) {
      doc.body.classList.toggle("dmi-on", this.settings.mode !== "off");
      // WKWebView keeps the native CSS chain GPU-accelerated; reference SVG
      // filters can be substantially more expensive there.
      doc.body.classList.toggle("dmi-native-filter", Platform.isIosApp);
      doc.body.classList.toggle("dmi-image-blend-light", this.settings.imageBlendLight);
      doc.body.classList.toggle("dmi-pdf-shadows", this.settings.pdfPageStyle === "shadows");
      doc.body.classList.toggle("dmi-pdf-invert-dark", this.settings.pdfInvertDark);
      doc.body.classList.toggle("dmi-pdf-blend-light", this.settings.pdfBlendLight);
      doc.body.style.setProperty("--dmi-image-opacity", String(this.settings.imageOpacity));
      doc.body.style.setProperty("--dmi-image-radius", `${this.settings.imageRadius}px`);
      doc.body.style.setProperty("--dmi-image-grid-fit", this.settings.imageGridFit);
      doc.body.style.setProperty(
        "--dmi-image-grid-background-light",
        this.settings.imageGridBackgroundLight
      );
      doc.body.style.setProperty(
        "--dmi-image-grid-background-dark",
        this.settings.imageGridBackgroundDark
      );
      doc.body.style.setProperty("--dmi-pdf-dark-opacity", String(this.settings.pdfDarkOpacity));
    }
  }

  private injectSvgFilter(doc: Document) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(NS, "svg") as SVGSVGElement;
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("dmi-defs");

    const filter = doc.createElementNS(NS, "filter");
    filter.id = "dmi-invert-hue";
    filter.setAttribute("color-interpolation-filters", "sRGB");

    const matrix = doc.createElementNS(NS, "feColorMatrix");
    matrix.setAttribute("type", "matrix");
    matrix.setAttribute("values", HUE_MATRIX);
    filter.appendChild(matrix);
    svg.appendChild(filter);
    doc.body.appendChild(svg);
    this.svgs.set(doc, svg);
  }

  /**
   * Remove current stamps and optionally discard all classifier decisions.
   * Mode changes keep the base cache; explicit re-analysis invalidates it.
   */
  private restamp(clearVerdicts: boolean) {
    this.cancelDrain();
    this.queue.length = 0;
    this.queued = new WeakSet<HTMLImageElement>();

    if (clearVerdicts) {
      this.cache.clear();
      this.settings.remoteVerdicts = {};
      this.remoteGeneration++;
      this.remoteWaiters.clear();
      void this.queueSave();
    }

    for (const doc of this.docs) {
      for (const image of Array.from(
        doc.body.querySelectorAll<HTMLImageElement>("img[data-dmi]")
      )) {
        this.clearStamp(image);
      }
    }
    this.processAll();
  }

  private startObserver(doc: Document) {
    const Observer = doc.defaultView?.MutationObserver ?? MutationObserver;
    const observer = new Observer((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          if (isImgElement(mutation.target)) {
            this.clearStamp(mutation.target);
            this.enqueue(mutation.target);
          } else if (mutation.target.nodeType === 1) {
            for (const image of Array.from(
              (mutation.target as Element).querySelectorAll<HTMLImageElement>("img")
            )) {
              this.clearStamp(image);
              this.enqueue(image);
            }
          }
          continue;
        }
        for (const node of Array.from(mutation.addedNodes)) {
          if (node.nodeType !== 1) continue;
          if (isImgElement(node)) {
            this.enqueue(node);
          } else {
            for (const image of Array.from((node as Element).querySelectorAll("img"))) {
              this.enqueue(image);
            }
          }
        }
      }
    });
    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "alt"],
    });
    this.observers.set(doc, observer);
  }

  private processAll() {
    for (const doc of this.docs) {
      for (const image of Array.from(doc.body.querySelectorAll("img"))) {
        this.enqueue(image);
      }
    }
  }

  private enqueue(img: HTMLImageElement) {
    if (this.disposed || this.settings.mode === "off") return;
    if (!img.closest(SCOPE) || img.classList.contains("emoji")) return;
    // A reused <img> can receive a new src while retaining our old stamp.
    // Clear it immediately so the new source gets the default treatment.
    if (img.dataset.dmiSrc && img.dataset.dmiSrc !== img.src) {
      this.clearStamp(img);
      this.retried.delete(img);
    }
    if (img.dataset.dmiSrc === img.src && img.dataset.dmi) return;

    // Explicit choices and cached decisions are synchronous so revisited
    // notes never wait for the idle queue.
    const override = this.overrideFor(img);
    if (override.noDim) img.dataset.dmiNoDim = "true";
    if (override.verdict) {
      this.stamp(img, override.verdict);
      return;
    }
    if (this.settings.mode === "all") {
      this.stamp(img, "invert");
      return;
    }

    const cached = this.cache.get(this.cacheKey(img));
    if (cached) {
      this.stamp(img, cached);
      return;
    }

    if (this.queued.has(img)) return;
    this.queued.add(img);
    this.queue.push(img);
    this.scheduleDrain();
  }

  private scheduleDrain() {
    if (this.frameHandle !== null || this.disposed) return;
    const drain = () => {
      this.frameHandle = null;
      if (this.disposed) return;
      const batch = this.queue.splice(0, 20);
      for (const image of batch) {
        this.queued.delete(image);
        this.process(image);
      }
      if (this.queue.length > 0) this.scheduleDrain();
    };

    // Decide the next small batch before the browser paints. Keeping this
    // work out of requestIdleCallback avoids a visible pending state while
    // retaining a per-frame cap for notes with many images.
    this.frameHandle = window.requestAnimationFrame(drain);
  }

  private cancelDrain() {
    if (this.frameHandle === null) return;
    window.cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  }

  private process(img: HTMLImageElement) {
    if (this.disposed || !img.isConnected || this.settings.mode === "off") return;

    const override = this.overrideFor(img);
    if (override.verdict) {
      this.stamp(img, override.verdict);
      return;
    }
    if (this.settings.mode === "all") {
      this.stamp(img, "invert");
      return;
    }

    const cacheKey = this.cacheKey(img);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.stamp(img, cached);
      return;
    }

    if (!img.complete) {
      this.waitForImage(img);
      return;
    }

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) {
      if (!this.retried.has(img)) {
        this.retried.add(img);
        window.setTimeout(() => {
          if (!this.disposed) this.process(img);
        }, 300);
      } else {
        this.remember(cacheKey, "invert", img);
      }
      return;
    }

    // Tiny UI glyphs are not useful classifier targets and often look worse
    // after inversion. Emoji are excluded before reaching this point.
    if (width < 8 || height < 8) {
      this.stamp(img, "keep");
      return;
    }

    const result = classifyImage(img);
    if (result) {
      this.remember(cacheKey, result.verdict, img);
      if (/^https?:/i.test(cacheKey)) this.persistRemote(cacheKey, result.verdict);
      return;
    }

    if (/^https?:/i.test(cacheKey)) {
      // Inversion is the safe default for the new classifier, so the image
      // is adapted immediately while a possible already-dark exemption is
      // fetched and analyzed in the background.
      this.stamp(img, "invert");
      void this.analyzeRemote(img, cacheKey);
      return;
    }

    this.remember(cacheKey, "invert", img);
  }

  private waitForImage(img: HTMLImageElement) {
    if (this.waitingForLoad.has(img)) return;
    this.waitingForLoad.add(img);
    const resume = () => {
      img.removeEventListener("load", resume);
      img.removeEventListener("error", resume);
      this.waitingForLoad.delete(img);
      // The image is decoded now, so stamp it in this event turn rather than
      // sending it through another frame of the queue.
      if (!this.disposed) this.process(img);
    };
    img.addEventListener("load", resume, { once: true });
    img.addEventListener("error", resume, { once: true });
  }

  private cacheKey(img: HTMLImageElement): string {
    return img.src.split("#", 1)[0];
  }

  private stamp(img: HTMLImageElement, baseVerdict: Verdict) {
    if (!img.isConnected || this.settings.mode === "off") return;
    const override = this.overrideFor(img);
    const verdict = override.verdict ??
      (this.settings.mode === "all" ? "invert" : baseVerdict);
    img.dataset.dmiSrc = img.src;
    img.dataset.dmi = verdict;
    if (override.noDim) img.dataset.dmiNoDim = "true";
    else delete img.dataset.dmiNoDim;
  }

  private clearStamp(img: HTMLImageElement) {
    img.removeAttribute("data-dmi");
    delete img.dataset.dmiSrc;
    delete img.dataset.dmiNoDim;
  }

  private remember(cacheKey: string, verdict: Verdict, img: HTMLImageElement) {
    this.cacheVerdict(cacheKey, verdict);
    // The element may have changed src while an asynchronous path ran.
    if (this.cacheKey(img) === cacheKey) this.stamp(img, verdict);
  }

  private rememberAll(
    cacheKey: string,
    verdict: Verdict,
    waiters: Set<HTMLImageElement>
  ) {
    this.cacheVerdict(cacheKey, verdict);
    for (const img of waiters) {
      if (this.cacheKey(img) === cacheKey) this.stamp(img, verdict);
    }
  }

  private cacheVerdict(cacheKey: string, verdict: Verdict) {
    if (!this.cache.has(cacheKey) && this.cache.size >= MEMORY_CACHE_MAX) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(cacheKey, verdict);
  }

  private seedRemoteCache() {
    for (const [url, verdict] of Object.entries(this.settings.remoteVerdicts)) {
      this.cacheVerdict(url, verdict);
    }
  }

  private persistRemote(cacheKey: string, verdict: Verdict) {
    const store = this.settings.remoteVerdicts;
    if (store[cacheKey]) delete store[cacheKey];
    while (Object.keys(store).length >= REMOTE_VERDICTS_MAX) {
      const oldest = Object.keys(store)[0];
      if (oldest === undefined) break;
      delete store[oldest];
    }
    store[cacheKey] = verdict;
    void this.queueSave();
  }

  private async analyzeRemote(img: HTMLImageElement, cacheKey: string) {
    const inFlight = this.remoteWaiters.get(cacheKey);
    if (inFlight) {
      inFlight.add(img);
      return;
    }

    const waiters = new Set<HTMLImageElement>([img]);
    const generation = this.remoteGeneration;
    this.remoteWaiters.set(cacheKey, waiters);
    try {
      const response = await requestUrl({ url: cacheKey });
      if (this.disposed || generation !== this.remoteGeneration) return;

      const type = response.headers?.["content-type"] ?? "image/png";
      const blob = new Blob([response.arrayBuffer], { type });
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(blob, {
          resizeWidth: 64,
          resizeHeight: 64,
          resizeQuality: "low",
        });
      } catch {
        bitmap = await createImageBitmap(blob);
      }

      if (this.disposed || generation !== this.remoteGeneration) {
        bitmap.close();
        return;
      }
      const result = classifySource(bitmap, bitmap.width, bitmap.height);
      bitmap.close();
      const verdict = result?.verdict ?? "invert";
      if (result) this.persistRemote(cacheKey, verdict);
      this.rememberAll(cacheKey, verdict, waiters);
    } catch {
      if (this.disposed || generation !== this.remoteGeneration) return;
      // A transient failure is not persisted, so a future render can retry.
      this.rememberAll(cacheKey, "invert", waiters);
    } finally {
      if (this.remoteWaiters.get(cacheKey) === waiters) {
        this.remoteWaiters.delete(cacheKey);
      }
    }
  }

  /** Explicit per-image control via source fragments or alt/alias text. */
  private overrideFor(img: HTMLImageElement): ImageOverride {
    const embed = img.closest(".internal-embed");
    const sources = [
      { value: img.getAttribute("alt") ?? "", isAlt: true },
      { value: img.getAttribute("src") ?? "", isAlt: false },
      { value: embed?.getAttribute("src") ?? "", isAlt: false },
      { value: embed?.getAttribute("alt") ?? "", isAlt: true },
    ];

    let keep = false;
    let invert = false;
    let noDim = false;
    for (const { value: source, isAlt } of sources) {
      // Obsidian sometimes serializes a literal # in an app URL as %23.
      const lower = source.toLowerCase().replace(/%23/g, "#");
      for (const match of lower.matchAll(TAG_RE)) {
        const token = match[1];
        if (TAGGED_KEEP.has(token)) keep = true;
        if (TAGGED_INVERT.has(token)) invert = true;
        if (TAGGED_NO_DIM.has(token)) noDim = true;
      }
      for (const token of lower.split(/[|,\s]+/)) {
        if (BARE_KEEP.has(token)) keep = true;
        if (isAlt && BARE_ALT_KEEP.has(token)) keep = true;
        if (BARE_INVERT.has(token)) invert = true;
        if (BARE_NO_DIM.has(token)) noDim = true;
      }
    }

    // A keep tag wins if conflicting tags are present: it is the safer
    // explicit choice and preserves the behavior of earlier versions.
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
        "Smart keeps the main rule: invert by default and leave already-dark images " +
          "uninverted. All inverts every untagged image. Off disables all effects below."
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ smart: "Smart (recommended)", all: "All images", off: "Off" })
          .setValue(this.plugin.settings.mode)
          .onChange(async (value) => {
            this.plugin.settings.mode = value as Mode;
            if (value !== "off") this.plugin.settings.lastActiveMode = value as ActiveMode;
            await this.plugin.saveMode();
          })
      );

    new Setting(containerEl).setName("Images").setHeading();

    new Setting(containerEl)
      .setName("Image opacity in dark mode")
      .setDesc(
        "Level of fading for inverted images in dark mode. Already-dark images and " +
          "images carrying an existing dark alt token stay at full opacity; hover " +
          "restores full opacity and #no-dim opts out. Existing noclick alt tokens " +
          "are also respected."
      )
      .addSlider((slider) =>
        slider
          .setLimits(0.25, 1, 0.05)
          .setValue(this.plugin.settings.imageOpacity)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.imageOpacity = value;
            await this.plugin.savePresentation();
          })
      );

    new Setting(containerEl)
      .setName("Image radius")
      .setDesc("Rounded corners for images.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 16, 1)
          .setValue(this.plugin.settings.imageRadius)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.imageRadius = value;
            await this.plugin.savePresentation();
          })
      );

    new Setting(containerEl)
      .setName("Blend images in light mode")
      .setDesc("Allow images to blend into the light color-scheme background.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.imageBlendLight).onChange(async (value) => {
          this.plugin.settings.imageBlendLight = value;
          await this.plugin.savePresentation();
        })
      );

    new Setting(containerEl)
      .setName("Image grid crop")
      .setDesc("How images fill cells in notes with the img-grid CSS class.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ cover: "Crop to fit", contain: "Show full image" })
          .setValue(this.plugin.settings.imageGridFit)
          .onChange(async (value) => {
            this.plugin.settings.imageGridFit = value as ImageGridFit;
            await this.plugin.savePresentation();
          })
      );

    new Setting(containerEl)
      .setName("Image grid background (light)")
      .setDesc("CSS color behind uncropped grid images; use transparent for none.")
      .addText((text) =>
        text
          .setPlaceholder("transparent")
          .setValue(this.plugin.settings.imageGridBackgroundLight)
          .onChange(async (value) => {
            const color = value.trim() || "transparent";
            if (!CSS.supports("color", color)) return;
            this.plugin.settings.imageGridBackgroundLight = color;
            await this.plugin.savePresentation();
          })
      );

    new Setting(containerEl)
      .setName("Image grid background (dark)")
      .setDesc("CSS color behind uncropped grid images; use transparent for none.")
      .addText((text) =>
        text
          .setPlaceholder("transparent")
          .setValue(this.plugin.settings.imageGridBackgroundDark)
          .onChange(async (value) => {
            const color = value.trim() || "transparent";
            if (!CSS.supports("color", color)) return;
            this.plugin.settings.imageGridBackgroundDark = color;
            await this.plugin.savePresentation();
          })
      );

    new Setting(containerEl).setName("Per-image control").setDesc(
      "Add #invert or #no-invert to override the automatic decision. Add #no-dim " +
        "to keep an image at full opacity. Existing dark and noclick alt tokens from " +
        "other snippets are respected automatically; this plugin never creates them."
    );

    new Setting(containerEl).setName("PDFs").setHeading();

    new Setting(containerEl)
      .setName("PDF page style")
      .setDesc("Borders and shadows around pages.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ seamless: "Seamless", shadows: "Shadows" })
          .setValue(this.plugin.settings.pdfPageStyle)
          .onChange(async (value) => {
            this.plugin.settings.pdfPageStyle = value as PdfPageStyle;
            await this.plugin.savePresentation();
          })
      );

    new Setting(containerEl)
      .setName("Invert PDFs in dark mode")
      .setDesc("Best for PDFs with black text on white pages.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.pdfInvertDark).onChange(async (value) => {
          this.plugin.settings.pdfInvertDark = value;
          await this.plugin.savePresentation();
        })
      );

    new Setting(containerEl)
      .setName("Blend PDFs in light mode")
      .setDesc("Allow PDF pages to blend into the light color-scheme background.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.pdfBlendLight).onChange(async (value) => {
          this.plugin.settings.pdfBlendLight = value;
          await this.plugin.savePresentation();
        })
      );

    new Setting(containerEl)
      .setName("PDF opacity in dark mode")
      .setDesc("Fade PDF pages in dark mode.")
      .addSlider((slider) =>
        slider
          .setLimits(0.25, 1, 0.05)
          .setValue(this.plugin.settings.pdfDarkOpacity)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.pdfDarkOpacity = value;
            await this.plugin.savePresentation();
          })
      );
  }
}
