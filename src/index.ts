import matter from "gray-matter";
import MarkdownIt from "markdown-it";
import markdownItTaskLists from "markdown-it-task-lists";
import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const DEFAULT_OUTPUT_DIR = ".make-up-markdown";
export const DEFAULT_DESIGN_FILE = "DESIGN-MD.md";
export const DEFAULT_ANNOTATIONS_FILE = `${DEFAULT_OUTPUT_DIR}/annotations.json`;

export interface InitOptions {
  cwd?: string;
}

export interface RenderOptions {
  cwd?: string;
  inputs?: string[];
}

export interface SyncOptions {
  cwd?: string;
  annotationsFile?: string;
  dryRun?: boolean;
}

export interface AnnotateOptions {
  cwd?: string;
  inputs?: string[];
  port?: number;
  host?: string;
}

export interface AnnotationServer {
  url: string;
  close(): Promise<void>;
}

export interface CommandResult {
  created: string[];
  reused: string[];
  updated: string[];
  generated: string[];
  warnings: string[];
}

interface DesignTokens {
  colors: {
    background: string;
    surface: string;
    text: string;
    muted: string;
    border: string;
    primary: string;
    onPrimary: string;
    codeBackground: string;
  };
  typography: {
    bodyFont: string;
    monoFont: string;
    bodySize: string;
    bodyLineHeight: string;
    h1Size: string;
    h2Size: string;
    h3Size: string;
    headingWeight: string;
  };
  rounded: {
    sm: string;
    md: string;
    lg: string;
  };
  spacing: {
    sm: string;
    md: string;
    lg: string;
    xl: string;
  };
}

type MarkdownToken = ReturnType<MarkdownIt["parse"]>[number];

interface RenderedMarkdownFile {
  html: string;
  hasMermaid: boolean;
  hasAnnotations: boolean;
  annotations: RenderedAnnotation[];
}

type AnnotationKind = "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "CAUTION";

interface RenderedAnnotation {
  id: string;
  source: string;
  blockStartLine: number;
  blockEndLine: number;
  quote: string;
  note: string;
  kind: AnnotationKind;
}

interface AnnotationSite {
  css: string;
  inputs: string[];
  pages: Map<string, string>;
  annotationsBySource: Map<string, RenderedAnnotation[]>;
  mermaidBundle?: string;
  hasMermaid: boolean;
}

interface SyncAnnotation {
  id: string;
  source: string;
  blockStartLine: number;
  blockEndLine: number;
  quote: string;
  note: string;
  kind: AnnotationKind;
}

interface ManagedAnnotationBlock {
  id: string;
  kind: AnnotationKind;
  blockStartLine?: number;
  blockEndLine?: number;
  quote: string;
  note: string;
  start: number;
  end: number;
}

interface FileSyncOperation {
  start: number;
  deleteCount: number;
  lines: string[];
  sequence: number;
}

const require = createRequire(import.meta.url);

const MERMAID_BUNDLE_FILE = "mermaid.min.js";
const MERMAID_INIT_FILE = "mermaid-init.js";
const MERMAID_ASSET_FILES = [MERMAID_BUNDLE_FILE, MERMAID_INIT_FILE];
const ANNOTATION_SCRIPT_FILE = "mum-annotate.js";
const SUPPORTED_ANNOTATION_KINDS: AnnotationKind[] = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"];
const SOURCE_POINT_TOKEN_TYPES = new Set([
  "heading_open",
  "paragraph_open",
  "bullet_list_open",
  "ordered_list_open",
  "list_item_open",
  "blockquote_open",
  "table_open",
  "hr",
  "code_block",
  "fence",
]);
const MERMAID_INIT_JS = `(() => {
  if (!globalThis.mermaid) {
    return;
  }

  globalThis.mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  globalThis.mermaid.run({ querySelector: ".mum-mermaid", suppressErrors: true });
})();
`;

const ANNOTATION_CSS = `

[data-mum-source-block] {
  position: relative;
  scroll-margin-block: var(--mum-space-xl);
}

[data-mum-source-block].mum-source-active,
[data-mum-source-block]:target {
  outline: 2px solid color-mix(in srgb, var(--mum-primary) 72%, transparent);
  outline-offset: 6px;
  border-radius: var(--mum-radius-sm);
  background: color-mix(in srgb, var(--mum-primary) 9%, transparent);
}

.mum-source-point-cluster {
  position: absolute;
  top: -0.1rem;
  left: calc(100% + var(--mum-space-sm));
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: center;
  max-width: 6rem;
}

.mum-source-point {
  position: relative;
  display: inline-grid;
  place-items: center;
  width: 1.85rem;
  height: 1.85rem;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--mum-primary) 62%, var(--mum-border));
  border-radius: 999px;
  background: color-mix(in srgb, var(--mum-primary) 10%, var(--mum-surface));
  color: var(--mum-primary);
  text-decoration: none;
  box-shadow: 0 3px 8px rgb(16 24 40 / 14%);
  transition: background 120ms ease, border-color 120ms ease, box-shadow 120ms ease, color 120ms ease, transform 120ms ease;
}

.mum-source-point-icon {
  width: 1rem;
  height: 1rem;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
  pointer-events: none;
}

.mum-source-point:hover,
.mum-source-point:focus-visible,
.mum-source-point.mum-source-point-active {
  border-color: var(--mum-primary);
  background: var(--mum-primary);
  color: var(--mum-on-primary);
  box-shadow: 0 6px 14px rgb(16 24 40 / 18%);
  transform: translateY(-1px);
}

.mum-source-point:focus-visible,
.mum-annotation-card:focus-visible,
.mum-annotation-source-link:focus-visible {
  outline: 2px solid var(--mum-primary);
  outline-offset: 2px;
}

.mum-annotation-card {
  scroll-margin-block: var(--mum-space-lg);
}

.mum-annotation-card.mum-annotation-active,
.mum-annotation-card:target {
  border-color: var(--mum-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--mum-primary) 18%, transparent);
}

.mum-annotation-source-link {
  color: var(--mum-primary);
  font-size: 0.875rem;
  font-weight: 700;
  text-decoration-thickness: 0.08em;
  text-underline-offset: 0.18em;
}

.mum-annotation-button {
  position: fixed;
  z-index: 10;
  min-width: 132px;
  padding: 0.55rem 0.75rem;
  border: 1px solid var(--mum-primary);
  border-radius: var(--mum-radius-md);
  background: var(--mum-primary);
  color: var(--mum-on-primary);
  font: inherit;
  font-weight: 700;
  box-shadow: 0 8px 18px rgb(15 23 42 / 18%);
  cursor: pointer;
}

.mum-annotation-button[hidden] {
  display: none;
}

.mum-annotation-dialog {
  width: min(100% - 32px, 560px);
  border: 1px solid var(--mum-border);
  border-radius: var(--mum-radius-md);
  background: var(--mum-surface);
  color: var(--mum-text);
  padding: 0;
}

.mum-annotation-dialog::backdrop {
  background: rgb(15 23 42 / 38%);
}

.mum-annotation-form {
  display: grid;
  gap: var(--mum-space-md);
  padding: var(--mum-space-lg);
}

.mum-annotation-title {
  margin: 0;
  font-size: 1.25rem;
  line-height: 1.2;
}

.mum-annotation-quote {
  margin: 0;
  padding: var(--mum-space-md);
  border-left: 4px solid var(--mum-primary);
  background: var(--mum-code-background);
  color: var(--mum-muted);
}

.mum-annotation-label {
  display: grid;
  gap: var(--mum-space-sm);
  font-weight: 700;
}

.mum-annotation-note {
  min-height: 128px;
  resize: vertical;
  padding: var(--mum-space-sm);
  border: 1px solid var(--mum-border);
  border-radius: var(--mum-radius-sm);
  background: var(--mum-surface);
  color: var(--mum-text);
  font: inherit;
}

.mum-annotation-kind {
  padding: var(--mum-space-sm);
  border: 1px solid var(--mum-border);
  border-radius: var(--mum-radius-sm);
  background: var(--mum-surface);
  color: var(--mum-text);
  font: inherit;
}

.mum-annotation-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--mum-space-sm);
}

.mum-annotation-actions button {
  min-width: 88px;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--mum-border);
  border-radius: var(--mum-radius-sm);
  background: var(--mum-surface);
  color: var(--mum-text);
  font: inherit;
  cursor: pointer;
}

.mum-annotation-actions button[type="submit"] {
  border-color: var(--mum-primary);
  background: var(--mum-primary);
  color: var(--mum-on-primary);
  font-weight: 700;
}

.mum-annotation-status {
  position: fixed;
  inset: auto var(--mum-space-md) var(--mum-space-md) auto;
  z-index: 11;
  max-width: min(420px, calc(100vw - 32px));
  margin: 0;
  padding: 0.65rem 0.8rem;
  border: 1px solid var(--mum-border);
  border-radius: var(--mum-radius-md);
  background: var(--mum-surface);
  color: var(--mum-text);
  box-shadow: 0 8px 18px rgb(15 23 42 / 14%);
}

.mum-annotation-status:empty {
  display: none;
}

.mum-annotation-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mum-space-sm);
  margin-top: var(--mum-space-md);
}

.mum-annotation-card-actions button {
  padding: 0.35rem 0.55rem;
  border: 1px solid var(--mum-border);
  border-radius: var(--mum-radius-sm);
  background: var(--mum-surface);
  color: var(--mum-text);
  font: inherit;
  font-size: 0.875rem;
  cursor: pointer;
}

.mum-annotation-card-actions button:focus-visible,
.mum-annotation-actions button:focus-visible,
.mum-annotation-button:focus-visible,
.mum-annotation-kind:focus-visible,
.mum-annotation-note:focus-visible {
  outline: 2px solid var(--mum-primary);
  outline-offset: 2px;
}

@media (max-width: 640px) {
  .mum-source-point-cluster {
    position: static;
    display: inline-flex;
    gap: 0.3rem;
    margin-right: var(--mum-space-sm);
    vertical-align: middle;
  }
}

@media (prefers-reduced-motion: reduce) {
  .mum-source-point {
    transition: none;
  }

  .mum-source-point:hover,
  .mum-source-point:focus-visible,
  .mum-source-point.mum-source-point-active {
    transform: none;
  }
}
`;

const ANNOTATION_JS = `(() => {
  const rail = document.querySelector("[data-mum-annotation-rail]");
  const annotatableSelector = "[data-mum-source-block][data-mum-source][data-mum-line-start][data-mum-line-end]";
  const sourcePointSelector = "[data-mum-source-point][data-mum-annotation-id]";
  let activeAnnotationId = null;

  function closestAnnotatable(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return element?.closest(annotatableSelector) ?? null;
  }

  function annotationIdFromHash() {
    const hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    for (const prefix of ["mum-annotation-", "mum-source-"]) {
      if (hash.startsWith(prefix)) {
        return hash.slice(prefix.length);
      }
    }
    return null;
  }

  function cardForAnnotation(id) {
    return document.getElementById("mum-annotation-" + id) ?? rail?.querySelector('[data-mum-annotation-id="' + id + '"]') ?? null;
  }

  function sourceTargetForAnnotation(id) {
    const target = document.getElementById("mum-source-" + id);
    return target?.closest(annotatableSelector) ?? target;
  }

  function clearActiveAnnotation() {
    document.querySelectorAll(".mum-source-active").forEach((element) => element.classList.remove("mum-source-active"));
    document.querySelectorAll(".mum-annotation-active").forEach((element) => element.classList.remove("mum-annotation-active"));
    document.querySelectorAll(".mum-source-point-active").forEach((element) => element.classList.remove("mum-source-point-active"));
  }

  function normalizeKind(kind) {
    return ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"].includes(kind) ? kind : "NOTE";
  }

  function activateAnnotation(id, target, options = {}) {
    const source = sourceTargetForAnnotation(id);
    const card = cardForAnnotation(id);
    const destination = target === "source" ? source : card;

    clearActiveAnnotation();
    source?.classList.add("mum-source-active");
    card?.classList.add("mum-annotation-active");
    document.querySelectorAll(sourcePointSelector).forEach((point) => {
      if (point.dataset.mumAnnotationId === id) {
        point.classList.add("mum-source-point-active");
      }
    });
    activeAnnotationId = id;

    if (destination && options.scroll !== false) {
      destination.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    if (destination && options.focus !== false && typeof destination.focus === "function") {
      destination.focus({ preventScroll: true });
    }
    if (options.hash !== false) {
      history.replaceState(null, "", "#" + (target === "source" ? "mum-source-" : "mum-annotation-") + id);
    }
  }

  function currentAnnotationIds() {
    return new Set([...rail?.querySelectorAll("[data-mum-annotation-id]") ?? []].map((card) => card.dataset.mumAnnotationId));
  }

  function sourceBlockForCard(card) {
    return [...document.querySelectorAll(annotatableSelector)].find((block) => {
      return block.dataset.mumSource === card.dataset.mumSource &&
        block.dataset.mumLineStart === card.dataset.mumLineStart &&
        block.dataset.mumLineEnd === card.dataset.mumLineEnd;
    }) ?? null;
  }

  function truncateLabelDetail(value) {
    const text = (value ?? "").replace(/\\s+/g, " ").trim();
    return text.length > 48 ? text.slice(0, 45) + "..." : text;
  }

  function sourcePointLabel(id, card) {
    if (!card) {
      return "View annotation " + id;
    }

    const kind = normalizeKind(card.dataset.mumKind).toLowerCase();
    const start = card.dataset.mumLineStart;
    const end = card.dataset.mumLineEnd;
    const range = start && end
      ? start === end
        ? "line " + start
        : "lines " + start + "-" + end
      : "the source";
    const detail = truncateLabelDetail(card.dataset.mumNote);
    return "View " + kind + " annotation on " + range + (detail ? ": " + detail : "");
  }

  function renderSourcePointIcon() {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("class", "mum-source-point-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");

    const bubble = document.createElementNS(namespace, "path");
    bubble.setAttribute("d", "M6 5h12v9H11l-5 4v-4H6z");

    svg.append(bubble);
    return svg;
  }

  function renderSourcePoint(id, card) {
    const link = document.createElement("a");
    link.className = "mum-source-point";
    link.href = "#mum-annotation-" + id;
    link.dataset.mumSourcePoint = "";
    link.dataset.mumAnnotationId = id;
    if (card?.dataset.mumKind) {
      link.dataset.mumKind = normalizeKind(card.dataset.mumKind);
    }
    const label = document.createElement("span");
    label.className = "mum-visually-hidden";
    label.textContent = sourcePointLabel(id, card);
    link.append(renderSourcePointIcon(), label);
    return link;
  }

  function syncSourcePointsFromRail() {
    if (!rail) {
      return;
    }

    const ids = currentAnnotationIds();
    document.querySelectorAll(sourcePointSelector).forEach((point) => {
      if (!ids.has(point.dataset.mumAnnotationId)) {
        point.remove();
      }
    });

    rail.querySelectorAll("[data-mum-annotation-id]").forEach((card) => {
      const id = card.dataset.mumAnnotationId;
      if (!id || document.getElementById("mum-source-" + id)) {
        return;
      }

      const block = sourceBlockForCard(card);
      if (!block) {
        return;
      }

      if (!block.id) {
        block.id = "mum-source-" + id;
      } else {
        const anchor = document.createElement("span");
        anchor.id = "mum-source-" + id;
        anchor.className = "mum-visually-hidden";
        block.prepend(anchor);
      }
      block.dataset.mumAnnotationIds = [block.dataset.mumAnnotationIds, id].filter(Boolean).join(" ");

      let cluster = block.querySelector(":scope > [data-mum-source-point-cluster]");
      if (!cluster) {
        cluster = document.createElement("span");
        cluster.className = "mum-source-point-cluster";
        cluster.dataset.mumSourcePointCluster = "";
        cluster.setAttribute("aria-label", "Annotations");
        block.prepend(cluster);
      }
      cluster.append(renderSourcePoint(id, card));
    });
  }

  function refreshAnnotationNavigation() {
    syncSourcePointsFromRail();
    const hashId = annotationIdFromHash();
    if (hashId) {
      activateAnnotation(hashId, window.location.hash.includes("mum-source-") ? "source" : "annotation", {
        hash: false,
        scroll: false,
        focus: false,
      });
    } else if (activeAnnotationId && cardForAnnotation(activeAnnotationId)) {
      activateAnnotation(activeAnnotationId, "annotation", { hash: false, scroll: false, focus: false });
    } else {
      clearActiveAnnotation();
    }
  }

  function setRailHtml(html) {
    rail.innerHTML = html;
    refreshAnnotationNavigation();
  }

  if (rail) {
    syncSourcePointsFromRail();

    document.addEventListener("click", (event) => {
      const sourcePoint = event.target.closest(sourcePointSelector);
      if (sourcePoint) {
        event.preventDefault();
        activateAnnotation(sourcePoint.dataset.mumAnnotationId, "annotation");
      }
    });

    rail.addEventListener("click", (event) => {
      if (event.target.closest("button[data-mum-annotation-action]")) {
        return;
      }

      const sourceLink = event.target.closest(".mum-annotation-source-link");
      if (sourceLink) {
        const card = sourceLink.closest("[data-mum-annotation-id]");
        if (card?.dataset.mumAnnotationId) {
          event.preventDefault();
          activateAnnotation(card.dataset.mumAnnotationId, "source");
        }
        return;
      }

      if (event.target.closest("a, button, input, select, textarea")) {
        return;
      }

      const card = event.target.closest("[data-mum-annotation-id]");
      if (card?.dataset.mumAnnotationId) {
        activateAnnotation(card.dataset.mumAnnotationId, "source");
      }
    });

    window.addEventListener("hashchange", () => {
      const id = annotationIdFromHash();
      if (id) {
        activateAnnotation(id, window.location.hash.includes("mum-source-") ? "source" : "annotation", {
          hash: false,
        });
      }
    });

    refreshAnnotationNavigation();
  }

  const addButton = document.querySelector(".mum-annotation-button");
  const dialog = document.querySelector(".mum-annotation-dialog");
  const form = document.querySelector(".mum-annotation-form");
  const cancelButton = document.querySelector(".mum-annotation-cancel");
  const title = document.querySelector(".mum-annotation-title");
  const quoteOutput = document.querySelector(".mum-annotation-quote");
  const kindInput = document.querySelector(".mum-annotation-kind");
  const noteInput = document.querySelector(".mum-annotation-note");
  const status = document.querySelector(".mum-annotation-status");
  const submitButton = form?.querySelector('button[type="submit"]');

  if (!addButton || !dialog || !form || !cancelButton || !title || !quoteOutput || !kindInput || !noteInput || !status || !rail || !submitButton) {
    return;
  }

  let pendingAnnotation = null;
  let editingAnnotation = null;
  let statusTimer = 0;

  function setStatus(message) {
    status.textContent = message;
    window.clearTimeout(statusTimer);
    if (message) {
      statusTimer = window.setTimeout(() => {
        status.textContent = "";
      }, 3600);
    }
  }

  function hideButton() {
    addButton.hidden = true;
    pendingAnnotation = null;
  }

  function openDialog(mode, annotation) {
    editingAnnotation = mode === "edit" ? annotation : null;
    title.textContent = mode === "edit" ? "Edit annotation" : "Add annotation";
    submitButton.textContent = mode === "edit" ? "Update" : "Save";
    quoteOutput.textContent = annotation.quote;
    kindInput.value = normalizeKind(annotation.kind);
    noteInput.value = mode === "edit" ? annotation.note : "";
    dialog.showModal();
    noteInput.focus();
  }

  function annotationFromSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const block = closestAnnotatable(range.startContainer);
    const endBlock = closestAnnotatable(range.endContainer);
    const quote = selection.toString().trim();

    if (!quote) {
      return null;
    }

    if (!block || !endBlock || block !== endBlock) {
      setStatus("Select text inside one Markdown block.");
      return null;
    }

    return {
      block,
      request: {
        source: block.dataset.mumSource,
        blockStartLine: Number(block.dataset.mumLineStart),
        blockEndLine: Number(block.dataset.mumLineEnd),
        quote,
      },
      rect: range.getBoundingClientRect(),
    };
  }

  function updateSelectionControl() {
    if (dialog.open) {
      return;
    }

    const annotation = annotationFromSelection();
    if (!annotation) {
      hideButton();
      return;
    }

    pendingAnnotation = annotation;
    const top = Math.max(8, annotation.rect.top - addButton.offsetHeight - 8);
    const left = Math.min(
      window.innerWidth - addButton.offsetWidth - 8,
      Math.max(8, annotation.rect.left + annotation.rect.width / 2 - addButton.offsetWidth / 2),
    );
    addButton.style.top = \`\${top}px\`;
    addButton.style.left = \`\${left}px\`;
    addButton.hidden = false;
  }

  function annotationFromCard(button) {
    const card = button.closest("[data-mum-annotation-id]");
    if (!card) {
      return null;
    }

    return {
      id: card.dataset.mumAnnotationId,
      source: card.dataset.mumSource,
      kind: normalizeKind(card.dataset.mumKind),
      quote: card.dataset.mumQuote ?? "",
      note: card.dataset.mumNote ?? "",
    };
  }

  document.addEventListener("selectionchange", () => {
    window.setTimeout(updateSelectionControl, 0);
  });
  document.addEventListener("keyup", updateSelectionControl);
  document.addEventListener("mouseup", updateSelectionControl);

  addButton.addEventListener("click", () => {
    if (!pendingAnnotation) {
      return;
    }

    openDialog("add", {
      quote: pendingAnnotation.request.quote,
      kind: "NOTE",
      note: "",
    });
  });

  cancelButton.addEventListener("click", () => {
    editingAnnotation = null;
    dialog.close();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!pendingAnnotation && !editingAnnotation) {
      return;
    }

    const note = noteInput.value.trim();
    if (!note) {
      setStatus("Enter a note before saving.");
      noteInput.focus();
      return;
    }

    const kind = normalizeKind(kindInput.value);
    const wasEditing = Boolean(editingAnnotation);
    const request = editingAnnotation
      ? { source: editingAnnotation.source, kind, note }
      : { ...pendingAnnotation.request, kind, note };
    const endpoint = editingAnnotation
      ? \`/api/annotations/\${encodeURIComponent(editingAnnotation.id)}\`
      : "/api/annotations";

    try {
      const response = await fetch(endpoint, {
        method: editingAnnotation ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error ?? "Annotation could not be saved.");
      }

      setRailHtml(payload.railHtml);
      dialog.close();
      hideButton();
      editingAnnotation = null;
      window.getSelection()?.removeAllRanges();
      setStatus(wasEditing ? "Annotation updated." : "Annotation saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  });

  rail.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-mum-annotation-action]");
    if (!button) {
      return;
    }

    const annotation = annotationFromCard(button);
    if (!annotation) {
      return;
    }

    if (button.dataset.mumAnnotationAction === "edit") {
      openDialog("edit", annotation);
      return;
    }

    if (button.dataset.mumAnnotationAction !== "delete") {
      return;
    }

    if (!window.confirm("Delete this annotation?")) {
      return;
    }

    try {
      const params = new URLSearchParams({ source: annotation.source });
      const response = await fetch(\`/api/annotations/\${encodeURIComponent(annotation.id)}?\${params}\`, {
        method: "DELETE",
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error ?? "Annotation could not be deleted.");
      }

      setRailHtml(payload.railHtml);
      setStatus("Annotation deleted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  });
})();
`;

const BUILT_IN_DESIGN: DesignTokens = {
  colors: {
    background: "#F8FAFC",
    surface: "#FFFFFF",
    text: "#111827",
    muted: "#4B5563",
    border: "#D1D5DB",
    primary: "#2563EB",
    onPrimary: "#FFFFFF",
    codeBackground: "#F3F4F6",
  },
  typography: {
    bodyFont:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    monoFont:
      '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace',
    bodySize: "16px",
    bodyLineHeight: "1.65",
    h1Size: "40px",
    h2Size: "28px",
    h3Size: "22px",
    headingWeight: "700",
  },
  rounded: {
    sm: "4px",
    md: "8px",
    lg: "12px",
  },
  spacing: {
    sm: "8px",
    md: "16px",
    lg: "24px",
    xl: "40px",
  },
};

const SUPPORTED_IMAGE_TYPES = new Map<string, string>([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

export const STARTER_DESIGN_MD = `---
version: alpha
name: Basic Docs
description: Local documentation presentation tokens for make-up-markdown output.
colors:
  primary: "#2563EB"
  on-primary: "#FFFFFF"
  background: "#F8FAFC"
  surface: "#FFFFFF"
  on-surface: "#111827"
  muted: "#4B5563"
  border: "#D1D5DB"
  code-background: "#F3F4F6"
typography:
  headline-lg:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: 0px
  headline-md:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: 0px
  body-md:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: 0px
  code-sm:
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, ui-monospace, monospace'
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 0px
rounded:
  sm: 4px
  md: 8px
  lg: 12px
spacing:
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
components:
  page:
    backgroundColor: "{colors.background}"
    textColor: "{colors.on-surface}"
    padding: "{spacing.xl}"
  document:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.lg}"
    padding: "{spacing.xl}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  link:
    textColor: "{colors.primary}"
  code:
    backgroundColor: "{colors.code-background}"
    typography: "{typography.code-sm}"
    rounded: "{rounded.sm}"
  table:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm}"
  caption:
    textColor: "{colors.muted}"
    typography: "{typography.body-md}"
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
---

# Basic Docs

## Overview

This design system creates quiet, readable documentation pages that work from disk and keep attention on the rendered Markdown content.

## Colors

Use background for the browser canvas, surface for the document page, on-surface for primary text, and primary for links and focused states.

## Typography

Use the body type scale for prose and code tokens for fenced blocks, inline code, and preformatted examples. Headings should stay compact enough for technical documents.

## Layout

Constrain the document width, use a consistent vertical rhythm, and keep tables and code blocks scrollable rather than letting them overflow the viewport.

## Elevation & Depth

Use borders and tonal surfaces before shadows. Generated documents should remain printable and readable without decorative depth.

## Shapes

Use small radii for inline code and medium radii for tables, preformatted blocks, and the document surface.

## Components

Links, tables, code blocks, blockquotes, images, and horizontal rules should use the YAML tokens above. Components must remain legible at narrow viewport widths.

## Do's and Don'ts

- Do use the YAML front matter tokens as the implementation source of truth.
- Do support both light and dark system color schemes.
- Do keep generated pages self-contained and deterministic.
- Don't add remote fonts, scripts, analytics, or fetched assets to generated output.
`;

export async function initProject(options: InitOptions = {}): Promise<CommandResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const outputDir = path.join(cwd, DEFAULT_OUTPUT_DIR);
  const designPath = path.join(cwd, DEFAULT_DESIGN_FILE);
  const gitignorePath = path.join(cwd, ".gitignore");
  const result = emptyResult();

  await mkdir(outputDir, { recursive: true });
  result.created.push(relativePath(cwd, outputDir));

  if (await pathExists(designPath)) {
    result.reused.push(DEFAULT_DESIGN_FILE);
  } else {
    await writeFile(designPath, STARTER_DESIGN_MD, "utf8");
    result.created.push(DEFAULT_DESIGN_FILE);
  }

  const gitRepositoryDetected = await pathExists(path.join(cwd, ".git"));
  if (!gitRepositoryDetected) {
    result.warnings.push("No Git repository was detected in the current directory.");
  }

  const gitignoreChanged = await ensureOutputIsIgnored(gitignorePath);
  if (gitignoreChanged === "created") {
    result.created.push(".gitignore");
  } else if (gitignoreChanged === "updated") {
    result.updated.push(".gitignore");
  } else {
    result.reused.push(".gitignore");
  }

  return result;
}

export async function renderProject(options: RenderOptions = {}): Promise<CommandResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const outputDir = path.join(cwd, DEFAULT_OUTPUT_DIR);
  const result = emptyResult();
  const design = await loadDesign(cwd, result.warnings);
  const { inputs, hasExplicitInputs } = await resolveMarkdownInputs(cwd, options.inputs);

  if (inputs.length === 0) {
    throw new Error("No Markdown input files were found in the project.");
  }

  await mkdir(outputDir, { recursive: true });

  const renderedFiles: Array<{ outputName: string; html: string; hasMermaid: boolean; hasAnnotations: boolean }> = [];

  for (const input of inputs) {
    const inputPath = path.join(cwd, input);
    const markdown = await readFile(inputPath, "utf8");
    const outputName = outputFileName(input);
    const rendered = await renderMarkdownFile(markdown, inputPath, input, outputName, result.warnings);
    renderedFiles.push({ outputName, ...rendered });
  }

  const hasRenderedAnnotations = renderedFiles.some((rendered) => rendered.hasAnnotations);
  const stylesheetPath = await writeStylesheet(outputDir, design, hasRenderedAnnotations);
  result.generated.push(relativePath(cwd, stylesheetPath));

  if (!hasExplicitInputs) {
    await removeStaleHtml(outputDir, inputs.map((input) => outputFileName(input)));
  }

  if (renderedFiles.some((rendered) => rendered.hasMermaid)) {
    const mermaidAssets = await writeMermaidAssets(outputDir);
    result.generated.push(...mermaidAssets.map((assetPath) => relativePath(cwd, assetPath)));
  } else {
    await removeMermaidAssets(outputDir);
  }

  if (hasRenderedAnnotations) {
    const annotationScriptPath = await writeAnnotationAsset(outputDir);
    result.generated.push(relativePath(cwd, annotationScriptPath));
  } else {
    await removeAnnotationAsset(outputDir);
  }

  for (const { outputName, html } of renderedFiles) {
    const outputPath = path.join(outputDir, outputName);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, html, "utf8");
    result.generated.push(relativePath(cwd, outputPath));
  }

  const indexPath = await writeDocumentationIndex(outputDir);
  result.generated.push(relativePath(cwd, indexPath));

  return result;
}

export async function startAnnotationServer(options: AnnotateOptions = {}): Promise<AnnotationServer> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const { inputs } = await resolveMarkdownInputs(cwd, options.inputs);

  if (inputs.length === 0) {
    throw new Error("No Markdown input files were found in the project.");
  }

  let site = await buildAnnotationSite(cwd, inputs);

  const server = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith("/api/annotations")) {
        await handleAnnotationRequest(request, response, cwd, inputs, async () => {
          site = await buildAnnotationSite(cwd, inputs);
          return site;
        });
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "Method not allowed." });
        return;
      }

      await serveAnnotationAsset(request, response, site);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, error instanceof ValidationError ? 400 : 500, { error: message });
    }
  });

  await listen(server, port, host);
  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;

  return {
    url: `http://${hostForUrl(host)}:${resolvedPort}/`,
    close: () => closeServer(server),
  };
}

export async function syncAnnotations(options: SyncOptions = {}): Promise<CommandResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const annotationsPath = path.resolve(cwd, options.annotationsFile ?? DEFAULT_ANNOTATIONS_FILE);
  const result = emptyResult();

  if (!isInsideProject(cwd, annotationsPath)) {
    throw new Error(`Annotation file "${options.annotationsFile}" must be inside the project.`);
  }

  if (!(await pathExists(annotationsPath))) {
    result.warnings.push(`${relativePath(cwd, annotationsPath)} was not found; no annotations were synced.`);
    return result;
  }

  const annotationFile = await readAnnotationFile(annotationsPath);
  if (annotationFile.version !== 1) {
    result.warnings.push(`${relativePath(cwd, annotationsPath)} has unsupported version ${annotationFile.version}; no annotations were synced.`);
    return result;
  }

  const annotations = parseSyncAnnotations(annotationFile, relativePath(cwd, annotationsPath), result.warnings);
  await syncAnnotationList(cwd, annotations, options.dryRun === true, result);

  return result;
}

export function makeUpMarkdown(markdown: string): string {
  const md = createMarkdownIt();
  return md.render(hideManagedAnnotationMarkers(markdown));
}

async function buildAnnotationSite(cwd: string, inputs: string[]): Promise<AnnotationSite> {
  const warnings: string[] = [];
  const design = await loadDesign(cwd, warnings);
  const pages = new Map<string, string>();
  const annotationsBySource = new Map<string, RenderedAnnotation[]>();
  let hasMermaid = false;

  for (const input of inputs) {
    const inputPath = path.join(cwd, input);
    const markdown = await readFile(inputPath, "utf8");
    const outputName = outputFileName(input);
    const rendered = await renderMarkdownFile(markdown, inputPath, input, outputName, warnings, {
      annotationSource: input,
    });
    pages.set(outputName, rendered.html);
    annotationsBySource.set(input, rendered.annotations);
    hasMermaid = hasMermaid || rendered.hasMermaid;
  }

  pages.set("index.html", renderIndexDocument([...pages.keys()].sort(compareStable)));

  return {
    css: renderCss(design) + ANNOTATION_CSS,
    inputs,
    pages,
    annotationsBySource,
    hasMermaid,
  };
}

async function handleAnnotationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  cwd: string,
  allowedInputs: string[],
  refresh: () => Promise<AnnotationSite>,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const match = requestUrl.pathname.match(/^\/api\/annotations(?:\/([^/]+))?$/);
  if (!match) {
    sendJson(response, 404, { error: "Annotation endpoint was not found." });
    return;
  }

  if (request.method === "POST" && !match[1]) {
    await handleAnnotationPost(request, response, cwd, allowedInputs, refresh);
    return;
  }

  if (request.method === "PATCH" && match[1]) {
    await handleAnnotationPatch(request, response, cwd, allowedInputs, decodeURIComponent(match[1]), refresh);
    return;
  }

  if (request.method === "DELETE" && match[1]) {
    await handleAnnotationDelete(requestUrl, response, cwd, allowedInputs, decodeURIComponent(match[1]), refresh);
    return;
  }

  sendJson(response, 405, { error: "Method not allowed." });
}

async function handleAnnotationPost(
  request: IncomingMessage,
  response: ServerResponse,
  cwd: string,
  allowedInputs: string[],
  refresh: () => Promise<AnnotationSite>,
): Promise<void> {
  const body = await readJsonRequest(request);
  const annotation = await annotationFromRequest(cwd, allowedInputs, body);
  const result = emptyResult();

  await syncAnnotationList(cwd, [annotation], false, result);
  if (result.warnings.length > 0 || result.updated.length === 0) {
    sendJson(response, 400, { error: result.warnings[0] ?? "Annotation could not be saved." });
    return;
  }

  const site = await refresh();
  sendJson(response, 201, { annotation, railHtml: railHtmlForSource(site, annotation.source) });
}

async function handleAnnotationPatch(
  request: IncomingMessage,
  response: ServerResponse,
  cwd: string,
  allowedInputs: string[],
  id: string,
  refresh: () => Promise<AnnotationSite>,
): Promise<void> {
  if (!isSafeAnnotationId(id)) {
    throw new ValidationError("Annotation id is invalid.");
  }

  const body = await readJsonRequest(request);
  const record = asRecord(body);
  const source = validateAnnotationSource(cwd, allowedInputs, stringValue(record.source));
  const kind = normalizeAnnotationKind(stringValue(record.kind));
  const note = stringValue(record.note)?.trim();

  if (!kind) {
    throw new ValidationError("Annotation kind is unsupported.");
  }

  if (!note) {
    throw new ValidationError("Annotation note is required.");
  }

  const updated = await updateManagedAnnotation(cwd, source, id, { kind, note });
  const site = await refresh();
  sendJson(response, 200, { annotation: updated, railHtml: railHtmlForSource(site, source) });
}

async function handleAnnotationDelete(
  requestUrl: URL,
  response: ServerResponse,
  cwd: string,
  allowedInputs: string[],
  id: string,
  refresh: () => Promise<AnnotationSite>,
): Promise<void> {
  if (!isSafeAnnotationId(id)) {
    throw new ValidationError("Annotation id is invalid.");
  }

  const source = validateAnnotationSource(cwd, allowedInputs, requestUrl.searchParams.get("source") ?? undefined);
  await deleteManagedAnnotation(cwd, source, id);
  const site = await refresh();
  sendJson(response, 200, { deleted: id, railHtml: railHtmlForSource(site, source) });
}

async function annotationFromRequest(
  cwd: string,
  allowedInputs: string[],
  body: unknown,
): Promise<SyncAnnotation> {
  const record = asRecord(body);
  const source = validateAnnotationSource(cwd, allowedInputs, stringValue(record.source));
  const blockStartLine = integerValue(record.blockStartLine);
  const blockEndLine = integerValue(record.blockEndLine);
  const quote = stringValue(record.quote)?.trim();
  const note = stringValue(record.note)?.trim();
  const kind = normalizeAnnotationKind(stringValue(record.kind)) ?? "NOTE";

  if (!blockStartLine || !blockEndLine || blockStartLine < 1 || blockEndLine < blockStartLine) {
    throw new ValidationError("Annotation line range is invalid.");
  }

  if (!quote) {
    throw new ValidationError("Annotation quote is required.");
  }

  if (!note) {
    throw new ValidationError("Annotation note is required.");
  }

  const sourcePath = path.resolve(cwd, source);
  const sourceMarkdown = await readFile(sourcePath, "utf8");
  const document = splitLines(sourceMarkdown);
  if (blockEndLine > document.lines.length) {
    throw new ValidationError("Annotation line range is outside the source file.");
  }

  return {
    id: `anno-${randomUUID()}`,
    source,
    blockStartLine,
    blockEndLine,
    quote,
    note,
    kind,
  };
}

async function serveAnnotationAsset(
  request: IncomingMessage,
  response: ServerResponse,
  site: AnnotationSite,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const pageName = decodeURIComponent(requestUrl.pathname.replace(/^\/+/, "")) || "index.html";

  if (pageName === "style.css") {
    sendText(response, 200, site.css, "text/css; charset=utf-8", request.method === "HEAD");
    return;
  }

  if (pageName === ANNOTATION_SCRIPT_FILE) {
    sendText(response, 200, ANNOTATION_JS, "text/javascript; charset=utf-8", request.method === "HEAD");
    return;
  }

  if (pageName === MERMAID_INIT_FILE && site.hasMermaid) {
    sendText(response, 200, MERMAID_INIT_JS, "text/javascript; charset=utf-8", request.method === "HEAD");
    return;
  }

  if (pageName === MERMAID_BUNDLE_FILE && site.hasMermaid) {
    const bundle = site.mermaidBundle ?? (await readFile(require.resolve("mermaid/dist/mermaid.min.js"), "utf8"));
    site.mermaidBundle = bundle;
    sendText(response, 200, bundle, "text/javascript; charset=utf-8", request.method === "HEAD");
    return;
  }

  const html = site.pages.get(pageName);
  if (html) {
    sendText(response, 200, html, "text/html; charset=utf-8", request.method === "HEAD");
    return;
  }

  sendText(response, 404, "Not found\n", "text/plain; charset=utf-8", request.method === "HEAD");
}

async function readJsonRequest(request: IncomingMessage): Promise<unknown> {
  let source = "";

  for await (const chunk of request) {
    source += chunk;
    if (source.length > 1_000_000) {
      throw new ValidationError("Request body is too large.");
    }
  }

  try {
    return JSON.parse(source || "{}") as unknown;
  } catch {
    throw new ValidationError("Request body must be valid JSON.");
  }
}

function sendJson(response: ServerResponse, statusCode: number, value: Record<string, unknown>): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType: string,
  headOnly = false,
): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
  });
  response.end(headOnly ? undefined : body);
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function hostForUrl(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`;
  }

  return host;
}

class ValidationError extends Error {}

async function readAnnotationFile(annotationsPath: string): Promise<Record<string, unknown>> {
  const source = await readFile(annotationsPath, "utf8");

  try {
    const parsed = JSON.parse(source) as unknown;
    return asRecord(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${annotationsPath}: ${message}`);
  }
}

function parseSyncAnnotations(
  annotationFile: Record<string, unknown>,
  annotationFileName: string,
  warnings: string[],
): SyncAnnotation[] {
  if (!Array.isArray(annotationFile.annotations)) {
    warnings.push(`${annotationFileName} does not contain an annotations array.`);
    return [];
  }

  const annotations: SyncAnnotation[] = [];

  annotationFile.annotations.forEach((value, index) => {
    const annotation = asRecord(value);
    const id = stringValue(annotation.id);
    const source = stringValue(annotation.source);
    const blockStartLine = integerValue(annotation.blockStartLine);
    const blockEndLine = integerValue(annotation.blockEndLine);
    const quote = stringValue(annotation.quote) ?? "";
    const note = stringValue(annotation.note);
    const kind = normalizeAnnotationKind(stringValue(annotation.kind)) ?? "NOTE";
    const label = id ?? `at index ${index}`;

    if (!id || !isSafeAnnotationId(id)) {
      warnings.push(`Annotation ${label} has a missing or invalid id; skipped.`);
      return;
    }

    if (!source) {
      warnings.push(`Annotation ${id} is missing a source; skipped.`);
      return;
    }

    if (!blockStartLine || !blockEndLine || blockStartLine < 1 || blockEndLine < blockStartLine) {
      warnings.push(`Annotation ${id} has an invalid line range; skipped.`);
      return;
    }

    if (!note || note.trim().length === 0) {
      warnings.push(`Annotation ${id} has an empty note; skipped.`);
      return;
    }

    annotations.push({
      id,
      source,
      blockStartLine,
      blockEndLine,
      quote,
      note,
      kind,
    });
  });

  return annotations;
}

async function syncAnnotationList(
  cwd: string,
  annotations: SyncAnnotation[],
  dryRun: boolean,
  result: CommandResult,
): Promise<void> {
  const annotationsBySource = new Map<string, SyncAnnotation[]>();
  const seenAnnotationIds = new Set<string>();

  for (const annotation of annotations) {
    if (seenAnnotationIds.has(annotation.id)) {
      result.warnings.push(`Annotation ${annotation.id} is duplicated; skipped.`);
      continue;
    }

    seenAnnotationIds.add(annotation.id);
    const sourcePath = path.resolve(cwd, annotation.source);
    if (!isInsideProject(cwd, sourcePath)) {
      result.warnings.push(`Annotation ${annotation.id} source "${annotation.source}" must be inside the project; skipped.`);
      continue;
    }

    const source = relativePath(cwd, sourcePath);
    annotationsBySource.set(source, [...(annotationsBySource.get(source) ?? []), annotation]);
  }

  for (const [source, sourceAnnotations] of annotationsBySource) {
    await syncAnnotationsForSource(cwd, source, sourceAnnotations, dryRun, result);
  }
}

async function syncAnnotationsForSource(
  cwd: string,
  source: string,
  annotations: SyncAnnotation[],
  dryRun: boolean,
  result: CommandResult,
): Promise<void> {
  const sourcePath = path.join(cwd, source);
  if (!(await pathExists(sourcePath))) {
    for (const annotation of annotations) {
      result.warnings.push(`${source}: annotation ${annotation.id} source file was not found; skipped.`);
    }
    return;
  }

  const original = await readFile(sourcePath, "utf8");
  const document = splitLines(original);
  const managedBlocks = managedAnnotationBlocks(document.lines);
  const operations: FileSyncOperation[] = [];
  let operationSequence = 0;

  for (const annotation of annotations) {
    if (!isValidAnnotationRange(annotation, document.lines.length)) {
      result.warnings.push(
        `${source}: annotation ${annotation.id} has invalid line range ${annotation.blockStartLine}-${annotation.blockEndLine}; skipped.`,
      );
      continue;
    }

    const replacementLines = renderAnnotationBlock(annotation);
    const existingBlocks = managedBlocks.get(annotation.id) ?? [];

    if (existingBlocks.length > 0) {
      const [firstBlock, ...duplicateBlocks] = existingBlocks;
      operations.push({
        start: firstBlock.start,
        deleteCount: firstBlock.end - firstBlock.start + 1,
        lines: replacementLines,
        sequence: operationSequence,
      });
      operationSequence += 1;

      for (const duplicateBlock of duplicateBlocks) {
        operations.push({
          start: duplicateBlock.start,
          deleteCount: duplicateBlock.end - duplicateBlock.start + 1,
          lines: [],
          sequence: operationSequence,
        });
        operationSequence += 1;
      }
    } else {
      operations.push({
        start: annotation.blockEndLine,
        deleteCount: 0,
        lines: replacementLines,
        sequence: operationSequence,
      });
      operationSequence += 1;
    }
  }

  if (operations.length === 0) {
    return;
  }

  const nextLines = applyFileSyncOperations(document.lines, operations);
  const nextSource = joinLines(nextLines, document.lineEnding, document.finalNewline);

  if (nextSource === original) {
    return;
  }

  if (!dryRun) {
    await writeFile(sourcePath, nextSource, "utf8");
  }
  result.updated.push(source);
}

async function updateManagedAnnotation(
  cwd: string,
  source: string,
  id: string,
  updates: { kind: AnnotationKind; note: string },
): Promise<RenderedAnnotation> {
  const sourcePath = path.join(cwd, source);
  const original = await readFile(sourcePath, "utf8");
  const document = splitLines(original);
  const block = managedAnnotationBlocks(document.lines).get(id)?.[0];

  if (!block) {
    throw new ValidationError("Annotation id was not found.");
  }

  const annotation: SyncAnnotation = {
    id,
    source,
    blockStartLine: block.blockStartLine ?? block.start + 1,
    blockEndLine: block.blockEndLine ?? block.start + 1,
    quote: block.quote,
    note: updates.note,
    kind: updates.kind,
  };
  const nextLines = applyFileSyncOperations(document.lines, [
    {
      start: block.start,
      deleteCount: block.end - block.start + 1,
      lines: renderAnnotationBlock(annotation),
      sequence: 0,
    },
  ]);

  await writeFile(sourcePath, joinLines(nextLines, document.lineEnding, document.finalNewline), "utf8");
  return annotation;
}

async function deleteManagedAnnotation(cwd: string, source: string, id: string): Promise<void> {
  const sourcePath = path.join(cwd, source);
  const original = await readFile(sourcePath, "utf8");
  const document = splitLines(original);
  const blocks = managedAnnotationBlocks(document.lines).get(id);

  if (!blocks || blocks.length === 0) {
    throw new ValidationError("Annotation id was not found.");
  }

  const operations = blocks.map((block, index) => ({
    start: block.start,
    deleteCount: block.end - block.start + 1,
    lines: [],
    sequence: index,
  }));
  const nextLines = applyFileSyncOperations(document.lines, operations);
  await writeFile(sourcePath, joinLines(nextLines, document.lineEnding, document.finalNewline), "utf8");
}

function managedAnnotationBlocks(lines: string[]): Map<string, ManagedAnnotationBlock[]> {
  const blocks = new Map<string, ManagedAnnotationBlock[]>();

  for (let index = 0; index < lines.length; index += 1) {
    const match = parseAnnotationStartMarker(lines[index]);
    if (!match) {
      continue;
    }

    const end = lines.findIndex((line, lineIndex) => lineIndex > index && line === "<!-- mum-annotation:end -->");
    if (end === -1) {
      continue;
    }

    const block = annotationBlockFromLines(lines, index, end, match);
    blocks.set(block.id, [...(blocks.get(block.id) ?? []), block]);
    index = end;
  }

  return blocks;
}

function extractManagedAnnotations(markdown: string, source: string): { markdown: string; annotations: RenderedAnnotation[] } {
  const document = splitLines(markdown);
  const outputLines: string[] = [];
  const annotations: RenderedAnnotation[] = [];

  for (let index = 0; index < document.lines.length; index += 1) {
    const marker = parseAnnotationStartMarker(document.lines[index]);
    if (!marker) {
      outputLines.push(document.lines[index]);
      continue;
    }

    const end = document.lines.findIndex((line, lineIndex) => lineIndex > index && line === "<!-- mum-annotation:end -->");
    if (end === -1) {
      outputLines.push(document.lines[index]);
      continue;
    }

    const block = annotationBlockFromLines(document.lines, index, end, marker);
    annotations.push({
      id: block.id,
      source,
      kind: block.kind,
      blockStartLine: block.blockStartLine ?? index + 1,
      blockEndLine: block.blockEndLine ?? index + 1,
      quote: block.quote,
      note: block.note,
    });
    outputLines.push(...Array.from({ length: end - index + 1 }, () => ""));
    index = end;
  }

  return {
    markdown: joinLines(outputLines, document.lineEnding, document.finalNewline),
    annotations,
  };
}

function parseAnnotationStartMarker(line: string): { id: string; attrs: Map<string, string> } | undefined {
  const match = line.match(/^<!-- mum-annotation:start\s+(.+) -->$/);
  if (!match) {
    return undefined;
  }

  const attrs = new Map<string, string>();
  for (const attrMatch of match[1].matchAll(/([a-z-]+)="([^"]*)"/g)) {
    attrs.set(attrMatch[1], attrMatch[2]);
  }

  const id = attrs.get("id");
  return id && isSafeAnnotationId(id) ? { id, attrs } : undefined;
}

function annotationBlockFromLines(
  lines: string[],
  start: number,
  end: number,
  marker: { id: string; attrs: Map<string, string> },
): ManagedAnnotationBlock {
  const body = lines.slice(start + 1, end);
  const calloutKind = body[0]?.match(/^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/)?.[1];
  const kind = normalizeAnnotationKind(marker.attrs.get("kind")) ?? normalizeAnnotationKind(calloutKind) ?? "NOTE";
  const quoteLineIndex = body.findIndex((line) => line.startsWith("> Annotation on: "));
  const quote = quoteLineIndex >= 0 ? parseAnnotationQuote(body[quoteLineIndex]) : "";
  const noteStart = quoteLineIndex >= 0 ? quoteLineIndex + 1 : body[0]?.startsWith("> [!") ? 1 : 0;
  const note = body
    .slice(noteStart)
    .map((line) => line.replace(/^> ?/, ""))
    .join("\n")
    .trim();
  const blockStartLine = positiveInteger(marker.attrs.get("block-start"));
  const blockEndLine = positiveInteger(marker.attrs.get("block-end"));

  return {
    id: marker.id,
    kind,
    blockStartLine,
    blockEndLine,
    quote,
    note,
    start,
    end,
  };
}

function parseAnnotationQuote(line: string): string {
  const raw = line.replace(/^> Annotation on: /, "");
  const match = raw.match(/^"([\s\S]*)"$/);
  return match ? match[1] : raw;
}

function renderAnnotationBlock(annotation: SyncAnnotation): string[] {
  return [
    `<!-- mum-annotation:start id="${annotation.id}" kind="${annotation.kind}" block-start="${annotation.blockStartLine}" block-end="${annotation.blockEndLine}" -->`,
    `> [!${annotation.kind}]`,
    `> Annotation on: "${annotation.quote.replaceAll("\n", " ")}"`,
    ...annotation.note.split(/\r?\n/).map((line) => (line.length > 0 ? `> ${line}` : ">")),
    "<!-- mum-annotation:end -->",
  ];
}

function applyFileSyncOperations(lines: string[], operations: FileSyncOperation[]): string[] {
  const nextLines = [...lines];
  const sortedOperations = [...operations].sort(
    (a, b) => b.start - a.start || b.sequence - a.sequence || b.deleteCount - a.deleteCount,
  );

  for (const operation of sortedOperations) {
    nextLines.splice(operation.start, operation.deleteCount, ...operation.lines);
  }

  return nextLines;
}

function splitLines(source: string): { lines: string[]; lineEnding: "\n" | "\r\n"; finalNewline: boolean } {
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  const normalized = source.replace(/\r\n/g, "\n");
  const finalNewline = normalized.endsWith("\n");
  const content = finalNewline ? normalized.slice(0, -1) : normalized;
  return {
    lines: content.length === 0 ? [] : content.split("\n"),
    lineEnding,
    finalNewline,
  };
}

function hideManagedAnnotationMarkers(markdown: string): string {
  return extractManagedAnnotations(markdown, "").markdown;
}

function joinLines(lines: string[], lineEnding: "\n" | "\r\n", finalNewline: boolean): string {
  const source = lines.join(lineEnding);
  return finalNewline ? `${source}${lineEnding}` : source;
}

function isValidAnnotationRange(annotation: SyncAnnotation, lineCount: number): boolean {
  return annotation.blockStartLine >= 1 && annotation.blockEndLine >= annotation.blockStartLine && annotation.blockEndLine <= lineCount;
}

function isSafeAnnotationId(id: string): boolean {
  return id.length > 0 && !/["<>\r\n]/.test(id);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return Number.isInteger(value) ? (value as number) : undefined;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeAnnotationKind(value: string | undefined): AnnotationKind | undefined {
  const upper = value?.toUpperCase();
  return SUPPORTED_ANNOTATION_KINDS.includes(upper as AnnotationKind) ? (upper as AnnotationKind) : undefined;
}

function validateAnnotationSource(cwd: string, allowedInputs: string[], source: string | undefined): string {
  if (!source) {
    throw new ValidationError("Annotation source is required.");
  }

  const sourcePath = path.resolve(cwd, source);
  if (!isInsideProject(cwd, sourcePath)) {
    throw new ValidationError("Annotation source must be inside the project.");
  }

  const relativeSource = relativePath(cwd, sourcePath);
  if (!allowedInputs.includes(relativeSource)) {
    throw new ValidationError("Annotation source is not part of this annotation session.");
  }

  return relativeSource;
}

async function loadDesign(cwd: string, warnings: string[]): Promise<DesignTokens> {
  const designPath = path.join(cwd, DEFAULT_DESIGN_FILE);
  if (!(await pathExists(designPath))) {
    warnings.push(`${DEFAULT_DESIGN_FILE} was not found; using built-in design defaults.`);
    return BUILT_IN_DESIGN;
  }

  const source = await readFile(designPath, "utf8");
  if (!hasYamlFrontMatter(source)) {
    warnings.push(`${DEFAULT_DESIGN_FILE} has no YAML front matter; using built-in design defaults.`);
    return BUILT_IN_DESIGN;
  }

  try {
    const parsed = matter(source);
    return mergeDesignTokens(parsed.data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${DEFAULT_DESIGN_FILE} YAML front matter: ${message}`);
  }
}

function mergeDesignTokens(data: Record<string, unknown>): DesignTokens {
  const colors = asRecord(data.colors);
  const typography = asRecord(data.typography);
  const rounded = asRecord(data.rounded);
  const spacing = asRecord(data.spacing);
  const body = asRecord(typography["body-md"]) ?? {};
  const h1 = asRecord(typography["headline-lg"]) ?? asRecord(typography["headline-md"]) ?? {};
  const h2 = asRecord(typography["headline-md"]) ?? {};
  const h3 = asRecord(typography["headline-sm"]) ?? asRecord(typography["headline-md"]) ?? {};
  const code = asRecord(typography["code-sm"]) ?? {};

  return {
    colors: {
      background: stringToken(colors.background, BUILT_IN_DESIGN.colors.background),
      surface: stringToken(colors.surface, BUILT_IN_DESIGN.colors.surface),
      text: stringToken(colors["on-surface"] ?? colors.text, BUILT_IN_DESIGN.colors.text),
      muted: stringToken(colors.muted, BUILT_IN_DESIGN.colors.muted),
      border: stringToken(colors.border, BUILT_IN_DESIGN.colors.border),
      primary: stringToken(colors.primary ?? colors.accent, BUILT_IN_DESIGN.colors.primary),
      onPrimary: stringToken(colors["on-primary"] ?? colors.accentText, BUILT_IN_DESIGN.colors.onPrimary),
      codeBackground: stringToken(
        colors["code-background"] ?? colors.codeBackground,
        BUILT_IN_DESIGN.colors.codeBackground,
      ),
    },
    typography: {
      bodyFont: stringToken(body.fontFamily, BUILT_IN_DESIGN.typography.bodyFont),
      monoFont: stringToken(code.fontFamily, BUILT_IN_DESIGN.typography.monoFont),
      bodySize: stringToken(body.fontSize, BUILT_IN_DESIGN.typography.bodySize),
      bodyLineHeight: stringToken(body.lineHeight, BUILT_IN_DESIGN.typography.bodyLineHeight),
      h1Size: stringToken(h1.fontSize, BUILT_IN_DESIGN.typography.h1Size),
      h2Size: stringToken(h2.fontSize, BUILT_IN_DESIGN.typography.h2Size),
      h3Size: stringToken(h3.fontSize, BUILT_IN_DESIGN.typography.h3Size),
      headingWeight: stringToken(h1.fontWeight, BUILT_IN_DESIGN.typography.headingWeight),
    },
    rounded: {
      sm: stringToken(rounded.sm, BUILT_IN_DESIGN.rounded.sm),
      md: stringToken(rounded.md, BUILT_IN_DESIGN.rounded.md),
      lg: stringToken(rounded.lg, BUILT_IN_DESIGN.rounded.lg),
    },
    spacing: {
      sm: stringToken(spacing.sm, BUILT_IN_DESIGN.spacing.sm),
      md: stringToken(spacing.md, BUILT_IN_DESIGN.spacing.md),
      lg: stringToken(spacing.lg, BUILT_IN_DESIGN.spacing.lg),
      xl: stringToken(spacing.xl, BUILT_IN_DESIGN.spacing.xl),
    },
  };
}

async function resolveMarkdownInputs(
  cwd: string,
  inputs: string[] | undefined,
): Promise<{ inputs: string[]; hasExplicitInputs: boolean }> {
  const hasExplicitInputs = (inputs?.length ?? 0) > 0;
  return {
    inputs: hasExplicitInputs ? await validateExplicitMarkdownInputs(cwd, inputs ?? []) : await discoverMarkdownInputs(cwd),
    hasExplicitInputs,
  };
}

async function discoverMarkdownInputs(cwd: string): Promise<string[]> {
  const inputs: string[] = [];

  async function walk(dir: string, relativeDir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (shouldSkipDefaultDiscoveryEntry(entry.name)) {
        continue;
      }

      const relativeName = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const entryPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(entryPath, relativeName);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        inputs.push(relativeName);
      }
    }
  }

  await walk(cwd, "");
  return inputs.sort(compareStable);
}

async function validateExplicitMarkdownInputs(cwd: string, inputs: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const validated: string[] = [];

  for (const input of inputs) {
    const inputPath = path.resolve(cwd, input);

    if (!isInsideProject(cwd, inputPath)) {
      throw new Error(`Markdown input "${input}" must be inside the project.`);
    }

    let stats;
    try {
      stats = await stat(inputPath);
    } catch {
      throw new Error(`Markdown input "${input}" was not found.`);
    }

    if (!stats.isFile()) {
      throw new Error(`Markdown input "${input}" is not a file.`);
    }

    if (path.extname(inputPath).toLowerCase() !== ".md") {
      throw new Error(`Markdown input "${input}" is not a Markdown file.`);
    }

    const relativeInput = relativePath(cwd, inputPath);
    if (!seen.has(relativeInput)) {
      seen.add(relativeInput);
      validated.push(relativeInput);
    }
  }

  return validated;
}

function shouldSkipDefaultDiscoveryEntry(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

async function renderMarkdownFile(
  markdown: string,
  inputPath: string,
  inputName: string,
  outputName: string,
  warnings: string[],
  options: { annotationSource?: string } = {},
): Promise<RenderedMarkdownFile> {
  const extracted = extractManagedAnnotations(markdown, inputName);
  const hasAnnotations = extracted.annotations.length > 0;
  const annotationSource = options.annotationSource ?? (hasAnnotations ? inputName : undefined);
  const md = createMarkdownIt({
    annotationSource,
    sourceAnnotations: extracted.annotations,
  });
  const tokens = md.parse(extracted.markdown, {});
  const hasMermaid = hasMermaidDiagram(tokens);
  await embedLocalImages(tokens, path.dirname(inputPath), inputName, warnings);
  const body = md.renderer.render(tokens, md.options, {});
  const title = firstHeading(tokens) ?? inputName.replace(/\.md$/i, "");
  const html = renderDocument(
    title,
    body,
    stylesheetHrefForOutput(outputName),
    scriptHrefsForOutput(outputName, hasMermaid, Boolean(options.annotationSource) || hasAnnotations),
    Boolean(options.annotationSource),
    extracted.annotations,
  );
  return { html, hasMermaid, hasAnnotations, annotations: extracted.annotations };
}

function createMarkdownIt(options: { annotationSource?: string; sourceAnnotations?: RenderedAnnotation[] } = {}): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
  }).use(markdownItTaskLists);

  const annotationSource = options.annotationSource;
  const sourceAnnotations = options.sourceAnnotations ?? [];
  const renderedSourceAnnotationIds = new Set<string>();

  addClassRule(md, "heading_open", (token) => {
    const level = token.tag.replace(/^h/i, "");
    return `mum-heading mum-h${level}`;
  }, annotationSource, sourceAnnotations, renderedSourceAnnotationIds);
  addClassRule(md, "paragraph_open", "mum-paragraph", annotationSource, sourceAnnotations, renderedSourceAnnotationIds);
  addClassRule(md, "link_open", "mum-link");
  addClassRule(
    md,
    "bullet_list_open",
    (token) => (hasClass(token, "contains-task-list") ? "mum-list mum-ul mum-task-list" : "mum-list mum-ul"),
    annotationSource,
    sourceAnnotations,
    renderedSourceAnnotationIds,
  );
  addClassRule(
    md,
    "ordered_list_open",
    (token) => (hasClass(token, "contains-task-list") ? "mum-list mum-ol mum-task-list" : "mum-list mum-ol"),
    annotationSource,
    sourceAnnotations,
    renderedSourceAnnotationIds,
  );
  addClassRule(
    md,
    "list_item_open",
    (token) => (hasClass(token, "task-list-item") ? "mum-list-item mum-task-list-item" : "mum-list-item"),
    annotationSource,
    sourceAnnotations,
    renderedSourceAnnotationIds,
  );
  addClassRule(md, "blockquote_open", "mum-blockquote", annotationSource, sourceAnnotations, renderedSourceAnnotationIds);
  addClassRule(md, "table_open", "mum-table", annotationSource, sourceAnnotations, renderedSourceAnnotationIds);
  addClassRule(md, "thead_open", "mum-table-head");
  addClassRule(md, "tbody_open", "mum-table-body");
  addClassRule(md, "tr_open", "mum-table-row");
  addClassRule(md, "th_open", "mum-table-cell mum-table-header");
  addClassRule(md, "td_open", "mum-table-cell");
  addClassRule(md, "hr", "mum-hr", annotationSource, sourceAnnotations, renderedSourceAnnotationIds);
  addClassRule(md, "s_open", "mum-strikethrough");

  md.renderer.rules.image = (tokens, idx, options, env, renderer) => {
    const token = tokens[idx];
    const altIndex = token.attrIndex("alt");
    if (altIndex >= 0 && token.attrs) {
      token.attrs[altIndex][1] = renderer.renderInlineAsText(token.children ?? [], options, env);
    }
    addClass(token, "mum-image");
    return renderer.renderToken(tokens, idx, options);
  };

  md.renderer.rules.code_inline = (tokens, idx) => {
    return `<code class="mum-code mum-code-inline">${escapeHtml(tokens[idx].content)}</code>`;
  };

  md.renderer.rules.code_block = (tokens, idx) => {
    const token = tokens[idx];
    const annotations = sourceAnnotationsForToken(token, sourceAnnotations, renderedSourceAnnotationIds);
    return `<pre class="mum-code-block"${annotationDataAttrs(token, annotationSource, annotations)}>${renderSourcePointCluster(annotations)}<code class="mum-code mum-code-block-code">${escapeHtml(token.content)}</code></pre>\n`;
  };

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const langName = token.info.trim().split(/\s+/)[0] ?? "";
    const annotations = sourceAnnotationsForToken(token, sourceAnnotations, renderedSourceAnnotationIds);
    if (isMermaidFenceInfo(token.info)) {
      return `<pre class="mum-mermaid mermaid"${annotationDataAttrs(token, annotationSource, annotations)}>${renderSourcePointCluster(annotations)}${escapeHtml(token.content)}</pre>\n`;
    }

    const languageClass = langName ? ` language-${escapeHtmlAttribute(langName)}` : "";
    return `<pre class="mum-code-block"${annotationDataAttrs(token, annotationSource, annotations)}>${renderSourcePointCluster(annotations)}<code class="mum-code mum-code-block-code${languageClass}">${escapeHtml(token.content)}</code></pre>\n`;
  };

  md.renderer.rules.html_inline = (tokens, idx) => {
    const content = tokens[idx].content;
    if (content.startsWith('<input class="task-list-item-checkbox"')) {
      return content.replace(
        'class="task-list-item-checkbox"',
        'class="task-list-item-checkbox mum-task-list-checkbox"',
      );
    }
    return content;
  };

  return md;
}

async function embedLocalImages(
  tokens: MarkdownToken[],
  sourceDir: string,
  inputName: string,
  warnings: string[],
): Promise<void> {
  for (const token of tokens) {
    if (token.type === "image") {
      await embedImageToken(token, sourceDir, inputName, warnings);
    }

    if (token.children) {
      await embedLocalImages(token.children, sourceDir, inputName, warnings);
    }
  }
}

function hasMermaidDiagram(tokens: MarkdownToken[]): boolean {
  return tokens.some((token) => {
    if (token.type === "fence" && isMermaidFenceInfo(token.info)) {
      return true;
    }

    return token.children ? hasMermaidDiagram(token.children) : false;
  });
}

function isMermaidFenceInfo(info: string): boolean {
  return info.trimStart().toLowerCase().startsWith("mermaid");
}

async function embedImageToken(
  token: MarkdownToken,
  sourceDir: string,
  inputName: string,
  warnings: string[],
): Promise<void> {
  const src = token.attrGet("src");
  if (!src || isPreservedImageUrl(src)) {
    return;
  }

  const { pathPart } = splitUrlPath(src);
  const imagePath = path.isAbsolute(pathPart)
    ? pathPart
    : path.resolve(sourceDir, decodeURIComponent(pathPart));
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = SUPPORTED_IMAGE_TYPES.get(ext);

  if (!mimeType) {
    warnings.push(`${inputName}: local image "${src}" is not a supported embeddable type.`);
    return;
  }

  try {
    const image = await readFile(imagePath);
    token.attrSet("src", `data:${mimeType};base64,${image.toString("base64")}`);
  } catch {
    warnings.push(`${inputName}: local image "${src}" could not be embedded.`);
  }
}

function renderDocument(
  title: string,
  body: string,
  stylesheetHref: string,
  scriptHrefs: string[] = [],
  includeAnnotationControls = false,
  annotations: RenderedAnnotation[] = [],
): string {
  const scripts = scriptHrefs
    .map((scriptHref) => `<script defer src="${escapeHtmlAttribute(scriptHref)}"></script>`)
    .join("\n");
  const scriptBlock = scripts ? `\n${scripts}` : "";
  const annotationControls = includeAnnotationControls ? renderAnnotationControls() : "";
  const annotationRail = annotations.length > 0 || includeAnnotationControls
    ? renderAnnotationRail(annotations, includeAnnotationControls)
    : "";
  const content = annotationRail
    ? `<div class="mum-page mum-page-with-annotations">
<main class="mum-document">
${body}</main>
${annotationRail}
</div>`
    : `<main class="mum-document">
${body}</main>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="generator" content="make-up-markdown 0.1.0">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${escapeHtmlAttribute(stylesheetHref)}">${scriptBlock}
</head>
<body>
${content}${annotationControls}
</body>
</html>
`;
}

function renderAnnotationControls(): string {
  return `
<button type="button" class="mum-annotation-button" hidden>Add annotation</button>
<dialog class="mum-annotation-dialog" closedby="any" aria-labelledby="mum-annotation-title">
<form class="mum-annotation-form">
<h2 class="mum-annotation-title" id="mum-annotation-title">Add annotation</h2>
<blockquote class="mum-annotation-quote"></blockquote>
<label class="mum-annotation-label" for="mum-annotation-kind">Kind
<select class="mum-annotation-kind" id="mum-annotation-kind">
${SUPPORTED_ANNOTATION_KINDS.map((kind) => `<option value="${kind}">${kind}</option>`).join("\n")}
</select>
</label>
<label class="mum-annotation-label" for="mum-annotation-note">Note
<textarea class="mum-annotation-note" id="mum-annotation-note" required></textarea>
</label>
<div class="mum-annotation-actions">
<button type="button" class="mum-annotation-cancel">Cancel</button>
<button type="submit">Save</button>
</div>
</form>
</dialog>
<p class="mum-annotation-status" role="status" aria-live="polite"></p>`;
}

function renderAnnotationRail(annotations: RenderedAnnotation[], editable: boolean): string {
  return `<aside class="mum-annotation-rail" aria-labelledby="mum-annotation-rail-title" data-mum-annotation-rail>
${renderAnnotationRailContents(annotations, editable)}
</aside>`;
}

function renderAnnotationRailContents(annotations: RenderedAnnotation[], editable: boolean): string {
  const emptyState = annotations.length === 0
    ? '<p class="mum-annotation-empty">No annotations yet.</p>'
    : "";
  const items = annotations.length > 0
    ? `<ol class="mum-annotation-list">
${annotations.map((annotation) => renderAnnotationCard(annotation, editable)).join("\n")}
</ol>`
    : "";

  return `<h2 class="mum-annotation-rail-title" id="mum-annotation-rail-title">Annotations</h2>
${emptyState}${items}`;
}

function renderAnnotationCard(annotation: RenderedAnnotation, editable: boolean): string {
  const range = annotation.blockStartLine === annotation.blockEndLine
    ? `Line ${annotation.blockStartLine}`
    : `Lines ${annotation.blockStartLine}-${annotation.blockEndLine}`;
  const actions = editable
    ? `<div class="mum-annotation-card-actions">
<button type="button" data-mum-annotation-action="edit">Edit<span class="mum-visually-hidden"> annotation ${escapeHtml(annotation.id)}</span></button>
<button type="button" data-mum-annotation-action="delete">Delete<span class="mum-visually-hidden"> annotation ${escapeHtml(annotation.id)}</span></button>
</div>`
    : "";

  return `<li class="mum-annotation-card" id="mum-annotation-${escapeHtmlAttribute(annotation.id)}" tabindex="-1" data-mum-annotation-id="${escapeHtmlAttribute(annotation.id)}" data-mum-source="${escapeHtmlAttribute(annotation.source)}" data-mum-kind="${annotation.kind}" data-mum-quote="${escapeHtmlAttribute(annotation.quote)}" data-mum-note="${escapeHtmlAttribute(annotation.note)}" data-mum-line-start="${annotation.blockStartLine}" data-mum-line-end="${annotation.blockEndLine}">
<p class="mum-annotation-card-meta"><span class="mum-annotation-kind-badge">${annotation.kind}</span><span>${escapeHtml(range)}</span><a class="mum-annotation-source-link" href="#mum-source-${escapeHtmlAttribute(annotation.id)}">View source<span class="mum-visually-hidden"> for annotation ${escapeHtml(annotation.id)}</span></a></p>
<blockquote class="mum-annotation-card-quote">${escapeHtml(annotation.quote)}</blockquote>
<p class="mum-annotation-card-note">${escapeHtml(annotation.note).replaceAll("\n", "<br>")}</p>
${actions}
</li>`;
}

function railHtmlForSource(site: AnnotationSite, source: string): string {
  return renderAnnotationRailContents(site.annotationsBySource.get(source) ?? [], true);
}

async function writeStylesheet(outputDir: string, design: DesignTokens, includeAnnotationCss = false): Promise<string> {
  const stylesheetPath = path.join(outputDir, "style.css");
  await writeFile(stylesheetPath, renderCss(design) + (includeAnnotationCss ? ANNOTATION_CSS : ""), "utf8");
  return stylesheetPath;
}

async function writeMermaidAssets(outputDir: string): Promise<string[]> {
  const bundlePath = path.join(outputDir, MERMAID_BUNDLE_FILE);
  const initPath = path.join(outputDir, MERMAID_INIT_FILE);

  await copyFile(require.resolve("mermaid/dist/mermaid.min.js"), bundlePath);
  await writeFile(initPath, MERMAID_INIT_JS, "utf8");

  return [bundlePath, initPath];
}

async function removeMermaidAssets(outputDir: string): Promise<void> {
  await Promise.all(
    MERMAID_ASSET_FILES.map(async (assetName) => {
      const assetPath = path.join(outputDir, assetName);
      if (await pathExists(assetPath)) {
        await unlink(assetPath);
      }
    }),
  );
}

async function writeAnnotationAsset(outputDir: string): Promise<string> {
  const scriptPath = path.join(outputDir, ANNOTATION_SCRIPT_FILE);
  await writeFile(scriptPath, ANNOTATION_JS, "utf8");
  return scriptPath;
}

async function removeAnnotationAsset(outputDir: string): Promise<void> {
  const scriptPath = path.join(outputDir, ANNOTATION_SCRIPT_FILE);
  if (await pathExists(scriptPath)) {
    await unlink(scriptPath);
  }
}

async function writeDocumentationIndex(outputDir: string): Promise<string> {
  const indexPath = path.join(outputDir, "index.html");
  const pages = await discoverGeneratedHtmlPages(outputDir);
  const html = renderIndexDocument(pages);
  await writeFile(indexPath, html, "utf8");
  return indexPath;
}

async function discoverGeneratedHtmlPages(outputDir: string): Promise<string[]> {
  const pages: string[] = [];

  async function walk(dir: string, relativeDir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const relativeName = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const entryPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(entryPath, relativeName);
      } else if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".html") &&
        relativeName !== "index.html"
      ) {
        pages.push(relativeName);
      }
    }
  }

  await walk(outputDir, "");
  return pages.sort(compareStable);
}

function renderIndexDocument(pages: string[]): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="generator" content="make-up-markdown 0.1.0">
<title>Documentation Index</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<main class="mum-document">
<h1 class="mum-heading mum-h1">Documentation Index</h1>
<nav aria-label="Generated documentation">
${renderIndexSections(pages)}
</nav>
</main>
</body>
</html>
`;
}

function renderIndexSections(pages: string[]): string {
  if (pages.length === 0) {
    return '<p class="mum-paragraph">No generated HTML pages were found.</p>';
  }

  return groupIndexPages(pages)
    .map((group, index) => {
      const headingId = `section-${index + 1}`;
      const title = group.folder === "" ? "Root" : group.folder;
      const links = group.pages
        .map(
          (page) =>
            `  <li class="mum-list-item"><a class="mum-link" href="${escapeHtmlAttribute(page)}">${escapeHtml(page)}</a></li>`,
        )
        .join("\n");

      return `<section aria-labelledby="${headingId}">
<h2 class="mum-heading mum-h2" id="${headingId}">${escapeHtml(title)}</h2>
<ul class="mum-list mum-ul">
${links}
</ul>
</section>`;
    })
    .join("\n");
}

function groupIndexPages(pages: string[]): Array<{ folder: string; pages: string[] }> {
  const grouped = new Map<string, string[]>();

  for (const page of pages) {
    const folder = path.posix.dirname(page);
    const groupName = folder === "." ? "" : folder;
    grouped.set(groupName, [...(grouped.get(groupName) ?? []), page]);
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => {
      if (a === "") {
        return -1;
      }
      if (b === "") {
        return 1;
      }
      return compareStable(a, b);
    })
    .map(([folder, groupPages]) => ({
      folder,
      pages: groupPages.sort(compareStable),
    }));
}

function renderCss(design: DesignTokens): string {
  const { colors, typography, rounded, spacing } = design;
  return `:root {
  color-scheme: light dark;
  accent-color: var(--mum-primary);
  scrollbar-color: var(--mum-border) var(--mum-background);
  --mum-background-light: ${colors.background};
  --mum-surface-light: ${colors.surface};
  --mum-text-light: ${colors.text};
  --mum-muted-light: ${colors.muted};
  --mum-border-light: ${colors.border};
  --mum-primary-light: ${colors.primary};
  --mum-on-primary-light: ${colors.onPrimary};
  --mum-code-background-light: ${colors.codeBackground};
  --mum-background-dark: #0F172A;
  --mum-surface-dark: #111827;
  --mum-text-dark: #E5E7EB;
  --mum-muted-dark: #9CA3AF;
  --mum-border-dark: #374151;
  --mum-primary-dark: #60A5FA;
  --mum-on-primary-dark: #0B1220;
  --mum-code-background-dark: #1F2937;
  --mum-background: var(--mum-background-light);
  --mum-surface: var(--mum-surface-light);
  --mum-text: var(--mum-text-light);
  --mum-muted: var(--mum-muted-light);
  --mum-border: var(--mum-border-light);
  --mum-primary: var(--mum-primary-light);
  --mum-on-primary: var(--mum-on-primary-light);
  --mum-code-background: var(--mum-code-background-light);
  --mum-document-shadow: 0 1px 2px rgb(16 24 40 / 6%);
  --mum-body-font: ${typography.bodyFont};
  --mum-mono-font: ${typography.monoFont};
  --mum-body-size: ${typography.bodySize};
  --mum-body-line-height: ${typography.bodyLineHeight};
  --mum-h1-size: ${typography.h1Size};
  --mum-h2-size: ${typography.h2Size};
  --mum-h3-size: ${typography.h3Size};
  --mum-heading-weight: ${typography.headingWeight};
  --mum-radius-sm: ${rounded.sm};
  --mum-radius-md: ${rounded.md};
  --mum-radius-lg: ${rounded.lg};
  --mum-space-sm: ${spacing.sm};
  --mum-space-md: ${spacing.md};
  --mum-space-lg: ${spacing.lg};
  --mum-space-xl: ${spacing.xl};
}

@media (prefers-color-scheme: dark) {
  :root {
    --mum-background: var(--mum-background-dark);
    --mum-surface: var(--mum-surface-dark);
    --mum-text: var(--mum-text-dark);
    --mum-muted: var(--mum-muted-dark);
    --mum-border: var(--mum-border-dark);
    --mum-primary: var(--mum-primary-dark);
    --mum-on-primary: var(--mum-on-primary-dark);
    --mum-code-background: var(--mum-code-background-dark);
    --mum-document-shadow: none;
  }
}

@supports (color: light-dark(white, black)) {
  :root {
    --mum-background: light-dark(var(--mum-background-light), var(--mum-background-dark));
    --mum-surface: light-dark(var(--mum-surface-light), var(--mum-surface-dark));
    --mum-text: light-dark(var(--mum-text-light), var(--mum-text-dark));
    --mum-muted: light-dark(var(--mum-muted-light), var(--mum-muted-dark));
    --mum-border: light-dark(var(--mum-border-light), var(--mum-border-dark));
    --mum-primary: light-dark(var(--mum-primary-light), var(--mum-primary-dark));
    --mum-on-primary: light-dark(var(--mum-on-primary-light), var(--mum-on-primary-dark));
    --mum-code-background: light-dark(var(--mum-code-background-light), var(--mum-code-background-dark));
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--mum-background);
  color: var(--mum-text);
  font-family: var(--mum-body-font);
  font-size: var(--mum-body-size);
  line-height: var(--mum-body-line-height);
  min-height: 100vh;
  overflow-wrap: break-word;
}

.mum-document {
  width: min(100% - 32px, 920px);
  margin: var(--mum-space-xl) auto;
  padding: var(--mum-space-xl);
  background: var(--mum-surface);
  border: 1px solid var(--mum-border);
  border-radius: var(--mum-radius-lg);
  box-shadow: var(--mum-document-shadow);
}

.mum-page {
  width: min(100% - 32px, 1280px);
  margin: var(--mum-space-xl) auto;
}

.mum-page-with-annotations {
  display: grid;
  grid-template-columns: minmax(0, 920px) minmax(260px, 320px);
  gap: var(--mum-space-lg);
  align-items: start;
  justify-content: center;
}

.mum-page-with-annotations .mum-document {
  width: 100%;
  margin: 0;
}

.mum-annotation-rail {
  position: sticky;
  top: var(--mum-space-lg);
  max-height: calc(100vh - (var(--mum-space-lg) * 2));
  overflow: auto;
  padding: var(--mum-space-md);
  background: var(--mum-surface);
  border: 1px solid var(--mum-border);
  border-radius: var(--mum-radius-md);
}

.mum-annotation-rail-title {
  margin: 0 0 var(--mum-space-md);
  font-size: 1rem;
  line-height: 1.25;
}

.mum-annotation-empty {
  margin: 0;
  color: var(--mum-muted);
}

.mum-annotation-list {
  display: grid;
  gap: var(--mum-space-md);
  margin: 0;
  padding: 0;
  list-style: none;
}

.mum-annotation-card {
  padding: var(--mum-space-md);
  border: 1px solid var(--mum-border);
  border-radius: var(--mum-radius-sm);
  background: var(--mum-code-background);
}

.mum-annotation-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mum-space-sm);
  align-items: center;
  margin: 0 0 var(--mum-space-sm);
  color: var(--mum-muted);
  font-size: 0.875rem;
}

.mum-annotation-kind-badge {
  border: 1px solid var(--mum-border);
  border-radius: var(--mum-radius-sm);
  padding: 0.05rem 0.35rem;
  background: var(--mum-surface);
  color: var(--mum-text);
  font-weight: 700;
}

.mum-annotation-card-quote {
  margin: 0 0 var(--mum-space-sm);
  padding-left: var(--mum-space-sm);
  border-left: 3px solid var(--mum-primary);
  color: var(--mum-muted);
  font-size: 0.9375rem;
}

.mum-annotation-card-note {
  margin: 0;
  color: var(--mum-text);
}

.mum-visually-hidden:where(:not(:focus-within, :active)) {
  position: absolute !important;
  clip-path: inset(50%) !important;
  overflow: hidden !important;
  width: 1px !important;
  height: 1px !important;
  margin: -1px !important;
  padding: 0 !important;
  border: 0 !important;
  white-space: nowrap !important;
}

.mum-document > :first-child {
  margin-top: 0;
}

.mum-document > :last-child {
  margin-bottom: 0;
}

.mum-heading {
  color: var(--mum-text);
  font-weight: var(--mum-heading-weight);
  line-height: 1.2;
  letter-spacing: 0;
  text-wrap: balance;
}

.mum-h1 {
  font-size: var(--mum-h1-size);
  margin: 0 0 var(--mum-space-lg);
}

.mum-h2 {
  font-size: var(--mum-h2-size);
  margin: var(--mum-space-xl) 0 var(--mum-space-md);
}

.mum-h3 {
  font-size: var(--mum-h3-size);
  margin: var(--mum-space-lg) 0 var(--mum-space-sm);
}

.mum-h4,
.mum-h5,
.mum-h6 {
  font-size: var(--mum-h3-size);
  margin: var(--mum-space-lg) 0 var(--mum-space-sm);
}

.mum-paragraph,
.mum-list,
.mum-blockquote,
.mum-code-block,
.mum-mermaid,
.mum-table {
  margin: 0 0 var(--mum-space-md);
}

.mum-link {
  color: var(--mum-primary);
  text-decoration-thickness: 0.08em;
  text-underline-offset: 0.18em;
}

.mum-link:focus-visible {
  outline: 2px solid var(--mum-primary);
  outline-offset: 2px;
  border-radius: var(--mum-radius-sm);
}

.mum-code,
.mum-code-block {
  font-family: var(--mum-mono-font);
}

.mum-code-inline {
  padding: 0.15em 0.35em;
  background: var(--mum-code-background);
  color: var(--mum-text);
  border-radius: var(--mum-radius-sm);
}

.mum-code-block {
  overflow-x: auto;
  padding: var(--mum-space-md);
  background: var(--mum-code-background);
  border: 1px solid var(--mum-border);
  border-radius: var(--mum-radius-md);
}

.mum-code-block-code {
  padding: 0;
  background: transparent;
  color: var(--mum-text);
}

.mum-mermaid {
  overflow-x: auto;
  padding: var(--mum-space-md);
  background: var(--mum-surface);
  border: 1px solid var(--mum-border);
  border-radius: var(--mum-radius-md);
  color: var(--mum-text);
  font-family: var(--mum-mono-font);
}

.mum-mermaid svg {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 0 auto;
}

.mum-blockquote {
  padding-left: var(--mum-space-md);
  color: var(--mum-muted);
  border-left: 4px solid var(--mum-primary);
}

.mum-list {
  padding-left: var(--mum-space-lg);
}

.mum-task-list {
  list-style: none;
  padding-left: 0;
}

.mum-task-list-item {
  display: flex;
  gap: var(--mum-space-sm);
  align-items: baseline;
}

.mum-task-list-checkbox {
  flex: 0 0 auto;
  accent-color: var(--mum-primary);
  transform: translateY(0.12em);
}

.mum-table {
  width: 100%;
  border-collapse: collapse;
  display: block;
  overflow-x: auto;
}

.mum-table-cell {
  padding: var(--mum-space-sm) var(--mum-space-md);
  border: 1px solid var(--mum-border);
  text-align: left;
  vertical-align: top;
}

.mum-table-header {
  font-weight: var(--mum-heading-weight);
  background: var(--mum-code-background);
  color: var(--mum-text);
}

.mum-image {
  max-width: 100%;
  height: auto;
}

.mum-hr {
  border: 0;
  border-top: 1px solid var(--mum-border);
  margin: var(--mum-space-xl) 0;
}

.mum-strikethrough {
  text-decoration: line-through;
}

@media (max-width: 640px) {
  .mum-page {
    width: 100%;
    margin: 0;
  }

  .mum-page-with-annotations {
    display: block;
  }

  .mum-document {
    width: 100%;
    margin: 0;
    padding: var(--mum-space-lg);
    border-left: 0;
    border-right: 0;
    border-radius: 0;
    box-shadow: none;
  }

  .mum-annotation-rail {
    position: static;
    max-height: none;
    margin: var(--mum-space-md);
  }
}`;
}

function addClassRule(
  md: MarkdownIt,
  tokenType: string,
  className: string | ((token: MarkdownToken) => string),
  annotationSource?: string,
  sourceAnnotations: RenderedAnnotation[] = [],
  renderedSourceAnnotationIds: Set<string> = new Set(),
): void {
  const defaultRender =
    md.renderer.rules[tokenType] ??
    ((tokens, idx, options, _env, renderer) => renderer.renderToken(tokens, idx, options));

  md.renderer.rules[tokenType] = (tokens, idx, options, env, renderer) => {
    const token = tokens[idx];
    const annotations = sourceAnnotationsForToken(token, sourceAnnotations, renderedSourceAnnotationIds);
    addClass(token, typeof className === "function" ? className(token) : className);
    addAnnotationDataAttrs(token, annotationSource, annotations);
    return defaultRender(tokens, idx, options, env, renderer) + renderSourcePointCluster(annotations);
  };
}

function addClass(token: MarkdownToken, className: string): void {
  token.attrJoin("class", className);
}

function sourceAnnotationsForToken(
  token: MarkdownToken,
  annotations: RenderedAnnotation[],
  renderedSourceAnnotationIds: Set<string>,
): RenderedAnnotation[] {
  if (!token.map || !SOURCE_POINT_TOKEN_TYPES.has(token.type)) {
    return [];
  }

  const startLine = token.map[0] + 1;
  const endLine = token.map[1];
  const matches = annotations.filter((annotation) => {
    return !renderedSourceAnnotationIds.has(annotation.id) &&
      annotation.blockStartLine === startLine &&
      annotation.blockEndLine === endLine;
  });

  for (const annotation of matches) {
    renderedSourceAnnotationIds.add(annotation.id);
  }

  return matches;
}

function addAnnotationDataAttrs(
  token: MarkdownToken,
  annotationSource: string | undefined,
  annotations: RenderedAnnotation[] = [],
): void {
  if (!annotationSource || !token.map) {
    return;
  }

  if (annotations.length > 0) {
    token.attrSet("id", `mum-source-${annotations[0]?.id}`);
    token.attrSet("tabindex", "-1");
    token.attrSet("data-mum-annotation-ids", annotations.map((annotation) => annotation.id).join(" "));
  }
  token.attrSet("data-mum-source-block", "");
  token.attrSet("data-mum-source", annotationSource);
  token.attrSet("data-mum-line-start", String(token.map[0] + 1));
  token.attrSet("data-mum-line-end", String(token.map[1]));
}

function annotationDataAttrs(
  token: MarkdownToken,
  annotationSource: string | undefined,
  annotations: RenderedAnnotation[] = [],
): string {
  if (!annotationSource || !token.map) {
    return "";
  }

  return [
    ...(annotations.length > 0
      ? [
        ` id="mum-source-${escapeHtmlAttribute(annotations[0]?.id ?? "")}"`,
        ` tabindex="-1"`,
        ` data-mum-annotation-ids="${escapeHtmlAttribute(annotations.map((annotation) => annotation.id).join(" "))}"`,
      ]
      : []),
    ` data-mum-source-block`,
    ` data-mum-source="${escapeHtmlAttribute(annotationSource)}"`,
    ` data-mum-line-start="${token.map[0] + 1}"`,
    ` data-mum-line-end="${token.map[1]}"`,
  ].join("");
}

function renderSourcePointCluster(annotations: RenderedAnnotation[]): string {
  if (annotations.length === 0) {
    return "";
  }

  const points = annotations
    .map((annotation, index) => {
      const extraAnchor = index === 0
        ? ""
        : `<span class="mum-visually-hidden" id="mum-source-${escapeHtmlAttribute(annotation.id)}"></span>`;
      return `${extraAnchor}<a class="mum-source-point" href="#mum-annotation-${escapeHtmlAttribute(annotation.id)}" data-mum-source-point data-mum-annotation-id="${escapeHtmlAttribute(annotation.id)}" data-mum-kind="${annotation.kind}">${sourcePointIconSvg()}<span class="mum-visually-hidden">${escapeHtml(sourcePointLabel(annotation))}</span></a>`;
    })
    .join("");

  return `<span class="mum-source-point-cluster" data-mum-source-point-cluster aria-label="Annotations">${points}</span>`;
}

function sourcePointIconSvg(): string {
  return `<svg class="mum-source-point-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 5h12v9H11l-5 4v-4H6z"></path></svg>`;
}

function sourcePointLabel(annotation: RenderedAnnotation): string {
  const range = annotation.blockStartLine === annotation.blockEndLine
    ? `line ${annotation.blockStartLine}`
    : `lines ${annotation.blockStartLine}-${annotation.blockEndLine}`;
  const detail = truncateLabelDetail(annotation.note);
  return `View ${annotation.kind.toLowerCase()} annotation on ${range}${detail ? `: ${detail}` : ""}`;
}

function truncateLabelDetail(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

function hasClass(token: MarkdownToken, className: string): boolean {
  return (token.attrGet("class") ?? "").split(/\s+/).includes(className);
}

async function ensureOutputIsIgnored(gitignorePath: string): Promise<"created" | "updated" | "reused"> {
  if (!(await pathExists(gitignorePath))) {
    await writeFile(gitignorePath, `${DEFAULT_OUTPUT_DIR}/\n`, "utf8");
    return "created";
  }

  const existing = await readFile(gitignorePath, "utf8");
  if (gitignoreCoversOutput(existing)) {
    return "reused";
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await writeFile(gitignorePath, `${existing}${prefix}${DEFAULT_OUTPUT_DIR}/\n`, "utf8");
  return "updated";
}

function gitignoreCoversOutput(source: string): boolean {
  return source.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
      return false;
    }

    return (
      trimmed === DEFAULT_OUTPUT_DIR ||
      trimmed === `${DEFAULT_OUTPUT_DIR}/` ||
      trimmed === `/${DEFAULT_OUTPUT_DIR}` ||
      trimmed === `/${DEFAULT_OUTPUT_DIR}/`
    );
  });
}

async function removeStaleHtml(outputDir: string, expectedNames: string[]): Promise<void> {
  const expected = new Set(expectedNames);

  async function walk(dir: string, relativeDir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const relativeName = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        const entryPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await walk(entryPath, relativeName);
          return;
        }

        if (entry.isFile() && entry.name.toLowerCase().endsWith(".html") && !expected.has(relativeName)) {
          await unlink(entryPath);
        }
      }),
    );
  }

  await walk(outputDir, "");
}

function outputFileName(inputName: string): string {
  return inputName.replace(/\.md$/i, ".html");
}

function stylesheetHrefForOutput(outputName: string): string {
  return assetHrefForOutput(outputName, "style.css");
}

function scriptHrefsForOutput(outputName: string, includeMermaid: boolean, includeAnnotations = false): string[] {
  return [
    ...(includeMermaid ? MERMAID_ASSET_FILES.map((assetName) => assetHrefForOutput(outputName, assetName)) : []),
    ...(includeAnnotations ? [assetHrefForOutput(outputName, ANNOTATION_SCRIPT_FILE)] : []),
  ];
}

function assetHrefForOutput(outputName: string, assetName: string): string {
  const outputDir = path.posix.dirname(outputName);
  if (outputDir === ".") {
    return assetName;
  }

  const depth = outputDir.split("/").filter(Boolean).length;
  return `${"../".repeat(depth)}${assetName}`;
}

function firstHeading(tokens: MarkdownToken[]): string | undefined {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index]?.type === "heading_open" && tokens[index + 1]?.type === "inline") {
      return tokens[index + 1]?.content;
    }
  }

  return undefined;
}

function splitUrlPath(src: string): { pathPart: string } {
  const splitIndex = src.search(/[?#]/);
  return { pathPart: splitIndex === -1 ? src : src.slice(0, splitIndex) };
}

function isPreservedImageUrl(src: string): boolean {
  return /^(?:https?:|data:)/i.test(src);
}

function hasYamlFrontMatter(source: string): boolean {
  return source.startsWith("---\n") || source.startsWith("---\r\n");
}

function stringToken(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function compareStable(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function relativePath(cwd: string, filePath: string): string {
  return path.relative(cwd, filePath).split(path.sep).join("/");
}

function isInsideProject(cwd: string, filePath: string): boolean {
  const relative = path.relative(cwd, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function emptyResult(): CommandResult {
  return {
    created: [],
    reused: [],
    updated: [],
    generated: [],
    warnings: [],
  };
}
