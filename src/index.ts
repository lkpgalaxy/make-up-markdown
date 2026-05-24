import matter from "gray-matter";
import MarkdownIt from "markdown-it";
import markdownItTaskLists from "markdown-it-task-lists";
import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export const DEFAULT_OUTPUT_DIR = ".make-up-markdown";
export const DEFAULT_DESIGN_FILE = "DESIGN-MD.md";

export interface InitOptions {
  cwd?: string;
}

export interface RenderOptions {
  cwd?: string;
  inputs?: string[];
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
}

const require = createRequire(import.meta.url);

const MERMAID_BUNDLE_FILE = "mermaid.min.js";
const MERMAID_INIT_FILE = "mermaid-init.js";
const MERMAID_ASSET_FILES = [MERMAID_BUNDLE_FILE, MERMAID_INIT_FILE];
const MERMAID_INIT_JS = `(() => {
  if (!globalThis.mermaid) {
    return;
  }

  globalThis.mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  globalThis.mermaid.run({ querySelector: ".mum-mermaid", suppressErrors: true });
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
  const hasExplicitInputs = (options.inputs?.length ?? 0) > 0;
  const inputs = hasExplicitInputs
    ? await validateExplicitMarkdownInputs(cwd, options.inputs ?? [])
    : await discoverMarkdownInputs(cwd);

  if (inputs.length === 0) {
    throw new Error("No Markdown input files were found in the project.");
  }

  await mkdir(outputDir, { recursive: true });
  const stylesheetPath = await writeStylesheet(outputDir, design);
  result.generated.push(relativePath(cwd, stylesheetPath));

  const renderedFiles: Array<{ outputName: string; html: string; hasMermaid: boolean }> = [];

  for (const input of inputs) {
    const inputPath = path.join(cwd, input);
    const markdown = await readFile(inputPath, "utf8");
    const outputName = outputFileName(input);
    const rendered = await renderMarkdownFile(markdown, inputPath, input, outputName, result.warnings);
    renderedFiles.push({ outputName, ...rendered });
  }

  if (!hasExplicitInputs) {
    await removeStaleHtml(outputDir, inputs.map((input) => outputFileName(input)));
  }

  if (renderedFiles.some((rendered) => rendered.hasMermaid)) {
    const mermaidAssets = await writeMermaidAssets(outputDir);
    result.generated.push(...mermaidAssets.map((assetPath) => relativePath(cwd, assetPath)));
  } else {
    await removeMermaidAssets(outputDir);
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

export function makeUpMarkdown(markdown: string): string {
  const md = createMarkdownIt();
  return md.render(markdown);
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
): Promise<RenderedMarkdownFile> {
  const md = createMarkdownIt();
  const tokens = md.parse(markdown, {});
  const hasMermaid = hasMermaidDiagram(tokens);
  await embedLocalImages(tokens, path.dirname(inputPath), inputName, warnings);
  const body = md.renderer.render(tokens, md.options, {});
  const title = firstHeading(tokens) ?? inputName.replace(/\.md$/i, "");
  const html = renderDocument(
    title,
    body,
    stylesheetHrefForOutput(outputName),
    scriptHrefsForOutput(outputName, hasMermaid),
  );
  return { html, hasMermaid };
}

function createMarkdownIt(): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
  }).use(markdownItTaskLists);

  addClassRule(md, "heading_open", (token) => {
    const level = token.tag.replace(/^h/i, "");
    return `mum-heading mum-h${level}`;
  });
  addClassRule(md, "paragraph_open", "mum-paragraph");
  addClassRule(md, "link_open", "mum-link");
  addClassRule(md, "bullet_list_open", (token) =>
    hasClass(token, "contains-task-list") ? "mum-list mum-ul mum-task-list" : "mum-list mum-ul",
  );
  addClassRule(md, "ordered_list_open", (token) =>
    hasClass(token, "contains-task-list") ? "mum-list mum-ol mum-task-list" : "mum-list mum-ol",
  );
  addClassRule(md, "list_item_open", (token) =>
    hasClass(token, "task-list-item") ? "mum-list-item mum-task-list-item" : "mum-list-item",
  );
  addClassRule(md, "blockquote_open", "mum-blockquote");
  addClassRule(md, "table_open", "mum-table");
  addClassRule(md, "thead_open", "mum-table-head");
  addClassRule(md, "tbody_open", "mum-table-body");
  addClassRule(md, "tr_open", "mum-table-row");
  addClassRule(md, "th_open", "mum-table-cell mum-table-header");
  addClassRule(md, "td_open", "mum-table-cell");
  addClassRule(md, "hr", "mum-hr");
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
    return `<pre class="mum-code-block"><code class="mum-code mum-code-block-code">${escapeHtml(tokens[idx].content)}</code></pre>\n`;
  };

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const langName = token.info.trim().split(/\s+/)[0] ?? "";
    if (isMermaidFenceInfo(token.info)) {
      return `<pre class="mum-mermaid mermaid">${escapeHtml(token.content)}</pre>\n`;
    }

    const languageClass = langName ? ` language-${escapeHtmlAttribute(langName)}` : "";
    return `<pre class="mum-code-block"><code class="mum-code mum-code-block-code${languageClass}">${escapeHtml(token.content)}</code></pre>\n`;
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

function renderDocument(title: string, body: string, stylesheetHref: string, scriptHrefs: string[] = []): string {
  const scripts = scriptHrefs
    .map((scriptHref) => `<script defer src="${escapeHtmlAttribute(scriptHref)}"></script>`)
    .join("\n");
  const scriptBlock = scripts ? `\n${scripts}` : "";

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
<main class="mum-document">
${body}</main>
</body>
</html>
`;
}

async function writeStylesheet(outputDir: string, design: DesignTokens): Promise<string> {
  const stylesheetPath = path.join(outputDir, "style.css");
  await writeFile(stylesheetPath, renderCss(design), "utf8");
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
  .mum-document {
    width: 100%;
    margin: 0;
    padding: var(--mum-space-lg);
    border-left: 0;
    border-right: 0;
    border-radius: 0;
    box-shadow: none;
  }
}`;
}

function addClassRule(md: MarkdownIt, tokenType: string, className: string | ((token: MarkdownToken) => string)): void {
  const defaultRender =
    md.renderer.rules[tokenType] ??
    ((tokens, idx, options, _env, renderer) => renderer.renderToken(tokens, idx, options));

  md.renderer.rules[tokenType] = (tokens, idx, options, env, renderer) => {
    addClass(tokens[idx], typeof className === "function" ? className(tokens[idx]) : className);
    return defaultRender(tokens, idx, options, env, renderer);
  };
}

function addClass(token: MarkdownToken, className: string): void {
  token.attrJoin("class", className);
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

function scriptHrefsForOutput(outputName: string, includeMermaid: boolean): string[] {
  if (!includeMermaid) {
    return [];
  }

  return MERMAID_ASSET_FILES.map((assetName) => assetHrefForOutput(outputName, assetName));
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
