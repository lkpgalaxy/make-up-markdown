import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DESIGN_FILE,
  DEFAULT_OUTPUT_DIR,
  STARTER_DESIGN_MD,
  initProject,
  makeUpMarkdown,
  renderProject,
  startAnnotationServer,
  syncAnnotations,
} from "../src/index.js";

describe("initProject", () => {
  it("creates the output directory, starter design file, and gitignore entry", async () => {
    const cwd = await tempProject();
    const result = await initProject({ cwd });

    await expect(stat(path.join(cwd, DEFAULT_OUTPUT_DIR))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(readFile(path.join(cwd, DEFAULT_DESIGN_FILE), "utf8")).resolves.toBe(STARTER_DESIGN_MD);
    await expect(readFile(path.join(cwd, ".gitignore"), "utf8")).resolves.toBe(".make-up-markdown/\n");
    expect(result.created).toEqual(expect.arrayContaining([DEFAULT_OUTPUT_DIR, DEFAULT_DESIGN_FILE, ".gitignore"]));
    expect(result.warnings).toEqual(["No Git repository was detected in the current directory."]);
  });

  it("reuses existing design files and does not duplicate gitignore coverage", async () => {
    const cwd = await tempProject();
    await mkdir(path.join(cwd, ".git"));
    await writeFile(path.join(cwd, DEFAULT_DESIGN_FILE), "user design", "utf8");
    await writeFile(path.join(cwd, ".gitignore"), "node_modules\n/.make-up-markdown/\n", "utf8");

    const result = await initProject({ cwd });

    await expect(readFile(path.join(cwd, DEFAULT_DESIGN_FILE), "utf8")).resolves.toBe("user design");
    await expect(readFile(path.join(cwd, ".gitignore"), "utf8")).resolves.toBe(
      "node_modules\n/.make-up-markdown/\n",
    );
    expect(result.reused).toEqual(expect.arrayContaining([DEFAULT_DESIGN_FILE, ".gitignore"]));
    expect(result.warnings).toEqual([]);
  });

  it("appends the output directory to an existing gitignore without changing existing content", async () => {
    const cwd = await tempProject();
    await writeFile(path.join(cwd, ".gitignore"), "node_modules\n", "utf8");

    const result = await initProject({ cwd });

    await expect(readFile(path.join(cwd, ".gitignore"), "utf8")).resolves.toBe(
      "node_modules\n.make-up-markdown/\n",
    );
    expect(result.updated).toEqual([".gitignore"]);
  });

  it("generates a starter design file with required front matter keys and canonical sections", async () => {
    const cwd = await tempProject();

    await initProject({ cwd });
    const design = await readFile(path.join(cwd, DEFAULT_DESIGN_FILE), "utf8");

    for (const key of [
      "version:",
      "name:",
      "description:",
      "colors:",
      "typography:",
      "rounded:",
      "spacing:",
      "components:",
    ]) {
      expect(design).toContain(key);
    }

    const sections = [
      "## Overview",
      "## Colors",
      "## Typography",
      "## Layout",
      "## Elevation & Depth",
      "## Shapes",
      "## Components",
      "## Do's and Don'ts",
    ];
    const positions = sections.map((section) => design.indexOf(section));

    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe("syncAnnotations", () => {
  it("inserts a managed callout after the annotated Markdown block", async () => {
    const cwd = await tempProject();
    await mkdir(path.join(cwd, DEFAULT_OUTPUT_DIR));
    await writeFile(path.join(cwd, "README.md"), "# Title\n\nParagraph one.\nParagraph two.\n\nTail.\n", "utf8");
    await writeFile(
      path.join(cwd, DEFAULT_OUTPUT_DIR, "annotations.json"),
      JSON.stringify({
        version: 1,
        annotations: [
          {
            id: "anno-1",
            source: "README.md",
            blockStartLine: 3,
            blockEndLine: 4,
            quote: "Paragraph one. Paragraph two.",
            note: "User note",
          },
        ],
      }),
      "utf8",
    );

    const result = await syncAnnotations({ cwd });
    const markdown = await readFile(path.join(cwd, "README.md"), "utf8");

    expect(result.updated).toEqual(["README.md"]);
    expect(result.warnings).toEqual([]);
    expect(markdown).toBe(`# Title

Paragraph one.
Paragraph two.
<!-- mum-annotation:start id="anno-1" kind="NOTE" block-start="3" block-end="4" -->
> [!NOTE]
> Annotation on: "Paragraph one. Paragraph two."
> User note
<!-- mum-annotation:end -->

Tail.
`);
  });

  it("updates an existing managed annotation instead of duplicating it", async () => {
    const cwd = await tempProject();
    await mkdir(path.join(cwd, DEFAULT_OUTPUT_DIR));
    await writeFile(
      path.join(cwd, "README.md"),
      `# Title

Paragraph.
<!-- mum-annotation:start id="anno-1" -->
> [!NOTE]
> Annotation on: "old"
> Old note
<!-- mum-annotation:end -->
`,
      "utf8",
    );
    await writeFile(
      path.join(cwd, DEFAULT_OUTPUT_DIR, "annotations.json"),
      JSON.stringify({
        version: 1,
        annotations: [
          {
            id: "anno-1",
            source: "README.md",
            blockStartLine: 3,
            blockEndLine: 3,
            quote: "Paragraph.",
            note: "Updated note",
          },
        ],
      }),
      "utf8",
    );

    const result = await syncAnnotations({ cwd });
    const markdown = await readFile(path.join(cwd, "README.md"), "utf8");
    const second = await syncAnnotations({ cwd });
    const markdownAgain = await readFile(path.join(cwd, "README.md"), "utf8");

    expect(result.updated).toEqual(["README.md"]);
    expect(second.updated).toEqual([]);
    expect(markdownAgain).toBe(markdown);
    expect(markdown.match(/mum-annotation:start/g)).toHaveLength(1);
    expect(markdown).toContain('> Annotation on: "Paragraph."');
    expect(markdown).toContain("> Updated note");
    expect(markdown).not.toContain("Old note");
  });

  it("reports dry-run updates without writing Markdown", async () => {
    const cwd = await tempProject();
    await mkdir(path.join(cwd, DEFAULT_OUTPUT_DIR));
    const originalMarkdown = "# Title\n\nParagraph.\n";
    await writeFile(path.join(cwd, "README.md"), originalMarkdown, "utf8");
    await writeFile(
      path.join(cwd, DEFAULT_OUTPUT_DIR, "annotations.json"),
      JSON.stringify({
        version: 1,
        annotations: [
          {
            id: "anno-1",
            source: "README.md",
            blockStartLine: 3,
            blockEndLine: 3,
            quote: "Paragraph.",
            note: "Dry note",
          },
        ],
      }),
      "utf8",
    );

    const result = await syncAnnotations({ cwd, dryRun: true });

    expect(result.updated).toEqual(["README.md"]);
    await expect(readFile(path.join(cwd, "README.md"), "utf8")).resolves.toBe(originalMarkdown);
  });

  it("warns and skips missing inputs, invalid line ranges, and empty notes", async () => {
    const missingAnnotations = await tempProject();

    await expect(syncAnnotations({ cwd: missingAnnotations })).resolves.toMatchObject({
      warnings: [".make-up-markdown/annotations.json was not found; no annotations were synced."],
    });

    const cwd = await tempProject();
    await mkdir(path.join(cwd, DEFAULT_OUTPUT_DIR));
    await writeFile(path.join(cwd, "README.md"), "# Title\n", "utf8");
    await writeFile(
      path.join(cwd, DEFAULT_OUTPUT_DIR, "annotations.json"),
      JSON.stringify({
        version: 1,
        annotations: [
          {
            id: "missing-source",
            blockStartLine: 1,
            blockEndLine: 1,
            quote: "Title",
            note: "No source",
          },
          {
            id: "missing-file",
            source: "missing.md",
            blockStartLine: 1,
            blockEndLine: 1,
            quote: "Missing",
            note: "No file",
          },
          {
            id: "bad-range",
            source: "README.md",
            blockStartLine: 1,
            blockEndLine: 4,
            quote: "Title",
            note: "Out of bounds",
          },
          {
            id: "empty-note",
            source: "README.md",
            blockStartLine: 1,
            blockEndLine: 1,
            quote: "Title",
            note: "",
          },
        ],
      }),
      "utf8",
    );

    const result = await syncAnnotations({ cwd });

    expect(result.updated).toEqual([]);
    expect(result.warnings).toEqual([
      "Annotation missing-source is missing a source; skipped.",
      "Annotation empty-note has an empty note; skipped.",
      "missing.md: annotation missing-file source file was not found; skipped.",
      "README.md: annotation bad-range has invalid line range 1-4; skipped.",
    ]);
    await expect(readFile(path.join(cwd, "README.md"), "utf8")).resolves.toBe("# Title\n");
  });
});

describe("startAnnotationServer", () => {
  it("serves annotation-enabled pages with source metadata and annotation assets", async () => {
    const cwd = await tempProject();
    await writeFile(path.join(cwd, DEFAULT_DESIGN_FILE), STARTER_DESIGN_MD, "utf8");
    await writeFile(path.join(cwd, "README.md"), "# Title\n\nParagraph one.\n", "utf8");

    const server = await startAnnotationServer({ cwd, inputs: ["README.md"], port: 0 });
    try {
      const html = await fetchText(new URL("README.html", server.url));
      const css = await fetchText(new URL("style.css", server.url));
      const script = await fetchText(new URL("mum-annotate.js", server.url));

      expect(html).toContain('<script defer src="mum-annotate.js"></script>');
      expect(html).toContain('class="mum-annotation-button" hidden');
      expect(html).toContain('data-mum-source="README.md"');
      expect(html).toContain('data-mum-line-start="3"');
      expect(html).toContain('data-mum-line-end="3"');
      expect(html).toContain("<dialog");
      expect(html).toContain('data-mum-annotation-rail');
      expect(html).toContain("No annotations yet.");
      expect(css).toContain(".mum-annotation-button");
      expect(css).toContain(".mum-source-point");
      expect(css).toContain(".mum-source-active");
      expect(css).toContain(".mum-annotation-card-actions");
      expect(script).toContain("activateAnnotation");
      expect(script).toContain("sourcePointSelector");
      expect(script).toContain('method: editingAnnotation ? "PATCH" : "POST"');
    } finally {
      await server.close();
    }
  });

  it("posts annotations into Markdown, refreshes served HTML, and rejects invalid saves without edits", async () => {
    const cwd = await tempProject();
    await writeFile(path.join(cwd, DEFAULT_DESIGN_FILE), STARTER_DESIGN_MD, "utf8");
    const originalMarkdown = "# Title\n\nParagraph one.\n\nTail.\n";
    await writeFile(path.join(cwd, "README.md"), originalMarkdown, "utf8");

    const server = await startAnnotationServer({ cwd, inputs: ["README.md"], port: 0 });
    try {
      for (const body of [
        { source: "../outside.md", blockStartLine: 3, blockEndLine: 3, quote: "Paragraph one.", note: "Nope" },
        { source: "README.md", blockStartLine: 9, blockEndLine: 9, quote: "Paragraph one.", note: "Nope" },
        { source: "README.md", blockStartLine: 3, blockEndLine: 3, quote: "", note: "Nope" },
        { source: "README.md", blockStartLine: 3, blockEndLine: 3, quote: "Paragraph one.", note: "" },
      ]) {
        const response = await postJson(new URL("api/annotations", server.url), body);
        expect(response.status).toBe(400);
      }

      await expect(readFile(path.join(cwd, "README.md"), "utf8")).resolves.toBe(originalMarkdown);

      const response = await postJson(new URL("api/annotations", server.url), {
        source: "README.md",
        blockStartLine: 3,
        blockEndLine: 3,
        quote: "Paragraph one.",
        note: "Browser note",
        kind: "WARNING",
      });
      const payload = (await response.json()) as { annotation: { id: string }; railHtml: string };
      const markdown = await readFile(path.join(cwd, "README.md"), "utf8");
      const refreshedHtml = await fetchText(new URL("README.html", server.url));

      expect(response.status).toBe(201);
      expect(payload.annotation.id).toMatch(/^anno-/);
      expect(markdown).toContain(`<!-- mum-annotation:start id="${payload.annotation.id}" kind="WARNING" block-start="3" block-end="3" -->`);
      expect(markdown).toContain("> [!WARNING]");
      expect(markdown).toContain('> Annotation on: "Paragraph one."');
      expect(markdown).toContain("> Browser note");
      expect(payload.railHtml).toContain("Browser note");
      expect(payload.railHtml).toContain("WARNING");
      expect(payload.railHtml).toContain(`id="mum-annotation-${payload.annotation.id}"`);
      expect(payload.railHtml).toContain(`href="#mum-source-${payload.annotation.id}"`);
      expect(refreshedHtml).toContain("Browser note");
      expect(refreshedHtml).toContain("mum-annotation-card");
      expect(refreshedHtml).toContain(`id="mum-source-${payload.annotation.id}"`);
      expect(refreshedHtml).toContain(`href="#mum-annotation-${payload.annotation.id}"`);
      expect(refreshedHtml).toContain(`id="mum-annotation-${payload.annotation.id}"`);
      expect(refreshedHtml).not.toContain("mum-annotation:start");
      expect(refreshedHtml).not.toContain("mum-annotation:end");
    } finally {
      await server.close();
    }
  });

  it("patches and deletes existing annotations while validating source, id, kind, and note", async () => {
    const cwd = await tempProject();
    await writeFile(path.join(cwd, DEFAULT_DESIGN_FILE), STARTER_DESIGN_MD, "utf8");
    await writeFile(
      path.join(cwd, "README.md"),
      `# Title

Paragraph one.
<!-- mum-annotation:start id="anno-1" -->
> [!NOTE]
> Annotation on: "Paragraph one."
> Browser note
<!-- mum-annotation:end -->

Tail.
`,
      "utf8",
    );

    const server = await startAnnotationServer({ cwd, inputs: ["README.md"], port: 0 });
    try {
      for (const { url, body } of [
        { url: new URL("api/annotations/missing", server.url), body: { source: "README.md", kind: "TIP", note: "Nope" } },
        { url: new URL("api/annotations/anno-1", server.url), body: { source: "../outside.md", kind: "TIP", note: "Nope" } },
        { url: new URL("api/annotations/anno-1", server.url), body: { source: "README.md", kind: "BAD", note: "Nope" } },
        { url: new URL("api/annotations/anno-1", server.url), body: { source: "README.md", kind: "TIP", note: "" } },
      ]) {
        const response = await patchJson(url, body);
        expect(response.status).toBe(400);
      }

      const patchResponse = await patchJson(new URL("api/annotations/anno-1", server.url), {
        source: "README.md",
        kind: "TIP",
        note: "Updated note",
      });
      const patchPayload = (await patchResponse.json()) as { railHtml: string };
      let markdown = await readFile(path.join(cwd, "README.md"), "utf8");

      expect(patchResponse.status).toBe(200);
      expect(markdown).toContain('<!-- mum-annotation:start id="anno-1" kind="TIP" block-start="4" block-end="4" -->');
      expect(markdown).toContain("> [!TIP]");
      expect(markdown).toContain('> Annotation on: "Paragraph one."');
      expect(markdown).toContain("> Updated note");
      expect(markdown).not.toContain("Browser note");
      expect(patchPayload.railHtml).toContain("Updated note");
      expect(patchPayload.railHtml).toContain("TIP");

      const invalidDelete = await fetch(new URL("api/annotations/anno-1?source=missing.md", server.url), {
        method: "DELETE",
      });
      expect(invalidDelete.status).toBe(400);

      const deleteResponse = await fetch(new URL("api/annotations/anno-1?source=README.md", server.url), {
        method: "DELETE",
      });
      const deletePayload = (await deleteResponse.json()) as { railHtml: string };
      markdown = await readFile(path.join(cwd, "README.md"), "utf8");

      expect(deleteResponse.status).toBe(200);
      expect(markdown).not.toContain("mum-annotation:start");
      expect(markdown).not.toContain("Updated note");
      expect(deletePayload.railHtml).toContain("No annotations yet.");
    } finally {
      await server.close();
    }
  });
});

describe("renderProject", () => {
  it("renders managed annotations in a read-only right rail without inline callouts", async () => {
    const cwd = await tempProject();
    await writeFile(path.join(cwd, DEFAULT_DESIGN_FILE), STARTER_DESIGN_MD, "utf8");
    await writeFile(
      path.join(cwd, "README.md"),
      `# Project

Paragraph one.
<!-- mum-annotation:start id="anno-1" kind="CAUTION" block-start="3" block-end="3" -->
> [!CAUTION]
> Annotation on: "Paragraph one."
> Static note
<!-- mum-annotation:end -->

Tail.
`,
      "utf8",
    );

    const result = await renderProject({ cwd, inputs: ["README.md"] });
    const html = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "README.html"), "utf8");
    const css = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "style.css"), "utf8");
    const script = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "mum-annotate.js"), "utf8");

    expect(result.generated).toContain(".make-up-markdown/mum-annotate.js");
    expect(html).toContain('<script defer src="mum-annotate.js"></script>');
    expect(html).toContain('data-mum-annotation-rail');
    expect(html).toContain("mum-annotation-card");
    expect(html).toContain('id="mum-source-anno-1"');
    expect(html).toContain('id="mum-annotation-anno-1"');
    expect(html).toContain('data-mum-annotation-id="anno-1"');
    expect(html).toContain('data-mum-line-start="3"');
    expect(html).toContain('data-mum-line-end="3"');
    expect(html).toContain('class="mum-source-point" href="#mum-annotation-anno-1"');
    expect(html).toContain('<svg class="mum-source-point-icon"');
    expect(html).toContain("View caution annotation on line 3: Static note");
    expect(html).toContain('href="#mum-source-anno-1"');
    expect(html).toContain("View source");
    expect(html).toContain("CAUTION");
    expect(html).toContain("Static note");
    expect(html).toContain("Line 3");
    expect(css).toContain(".mum-source-point");
    expect(css).toContain("left: calc(100% + var(--mum-space-sm));");
    expect(css).toContain(".mum-source-active");
    expect(css).toContain(".mum-annotation-active");
    expect(script).toContain("activateAnnotation");
    expect(html).not.toContain("mum-annotation-card-actions");
    expect(html).not.toContain("Edit annotation");
    expect(html).not.toContain("Delete annotation");
    expect(html).not.toContain("mum-annotation:start");
    expect(html).not.toContain("[!CAUTION]");
  });

  it("renders multiple source points for annotations on the same Markdown block", async () => {
    const cwd = await tempProject();
    await writeFile(path.join(cwd, DEFAULT_DESIGN_FILE), STARTER_DESIGN_MD, "utf8");
    await writeFile(
      path.join(cwd, "README.md"),
      `# Project

Paragraph one.
<!-- mum-annotation:start id="anno-1" kind="NOTE" block-start="3" block-end="3" -->
> [!NOTE]
> Annotation on: "Paragraph one."
> First note
<!-- mum-annotation:end -->
<!-- mum-annotation:start id="anno-2" kind="TIP" block-start="3" block-end="3" -->
> [!TIP]
> Annotation on: "Paragraph one."
> Second note
<!-- mum-annotation:end -->
`,
      "utf8",
    );

    await renderProject({ cwd, inputs: ["README.md"] });
    const html = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "README.html"), "utf8");

    expect(html.match(/class="mum-source-point"/g)).toHaveLength(2);
    expect(html.match(/class="mum-source-point-icon"/g)).toHaveLength(2);
    expect(html).toContain('id="mum-source-anno-1"');
    expect(html).toContain('id="mum-source-anno-2"');
    expect(html).toContain('href="#mum-annotation-anno-1"');
    expect(html).toContain('href="#mum-annotation-anno-2"');
  });

  it("renders visible Markdown files recursively by default without modifying them and refreshes stale output", async () => {
    const cwd = await tempProject();
    await writeFile(path.join(cwd, DEFAULT_DESIGN_FILE), STARTER_DESIGN_MD, "utf8");
    await writeFile(path.join(cwd, "agents.md"), "# Agents\n\nRendered alongside README.\n", "utf8");
    await mkdir(path.join(cwd, "docs"));
    await writeFile(path.join(cwd, "docs", "guide.md"), "# Guide\n\nRendered alongside README.\n", "utf8");
    await writeFile(
      path.join(cwd, "README.md"),
      "# Project\n\nSee [guide](docs/guide.md).\n\n![remote](https://example.com/image.png)\n",
      "utf8",
    );
    await mkdir(path.join(cwd, DEFAULT_OUTPUT_DIR));
    await writeFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "stale.html"), "stale", "utf8");
    await writeFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "mum-annotate.js"), "stale", "utf8");
    const before = await readFile(path.join(cwd, "README.md"), "utf8");

    const first = await renderProject({ cwd });
    const html = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "README.html"), "utf8");
    const index = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "index.html"), "utf8");
    const second = await renderProject({ cwd });
    const htmlAgain = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "README.html"), "utf8");
    const indexAgain = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "index.html"), "utf8");
    const outputNames = await readdir(path.join(cwd, DEFAULT_OUTPUT_DIR));

    expect(first.generated).toEqual([
      ".make-up-markdown/style.css",
      ".make-up-markdown/DESIGN-MD.html",
      ".make-up-markdown/README.html",
      ".make-up-markdown/agents.html",
      ".make-up-markdown/docs/guide.html",
      ".make-up-markdown/index.html",
    ]);
    expect(second.generated).toEqual([
      ".make-up-markdown/style.css",
      ".make-up-markdown/DESIGN-MD.html",
      ".make-up-markdown/README.html",
      ".make-up-markdown/agents.html",
      ".make-up-markdown/docs/guide.html",
      ".make-up-markdown/index.html",
    ]);
    expect(html).toBe(htmlAgain);
    expect(index).toBe(indexAgain);
    expect(await readFile(path.join(cwd, "README.md"), "utf8")).toBe(before);
    expect(html).toContain('<link rel="stylesheet" href="style.css">');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('<a href="docs/guide.md" class="mum-link">guide</a>');
    expect(html).toContain('<img src="https://example.com/image.png" alt="remote" class="mum-image">');
    expect(html).not.toContain("mum-annotation-button");
    expect(html).not.toContain("data-mum-source");
    expect(html).not.toContain("<style>");
    expect(index).toContain('<link rel="stylesheet" href="style.css">');
    expect(index).toContain('<meta name="color-scheme" content="light dark">');
    expect(index).not.toContain("<style>");
    expect(outputNames.sort()).toEqual([
      "DESIGN-MD.html",
      "README.html",
      "agents.html",
      "docs",
      "index.html",
      "style.css",
    ]);
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "mum-annotate.js"), "utf8")).rejects.toThrow();
    const stylesheet = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "style.css"), "utf8");
    expect(stylesheet).toContain("color-scheme: light dark;");
    expect(stylesheet).toContain("--mum-background-light: #F8FAFC;");
    expect(stylesheet).toContain("--mum-surface-light: #FFFFFF;");
    expect(stylesheet).toContain("--mum-text-light: #111827;");
    expect(stylesheet).toContain("--mum-muted-light: #4B5563;");
    expect(stylesheet).toContain("--mum-border-light: #D1D5DB;");
    expect(stylesheet).toContain("--mum-primary-light: #2563EB;");
    expect(stylesheet).toContain("--mum-code-background-light: #F3F4F6;");
    expect(stylesheet).toContain("--mum-background-dark: #0F172A;");
    expect(stylesheet).toContain("--mum-surface-dark: #111827;");
    expect(stylesheet).toContain("@media (prefers-color-scheme: dark)");
    expect(stylesheet).toContain("@supports (color: light-dark(white, black))");
    expect(stylesheet).toContain(".mum-heading");
    expect(stylesheet).toContain(".mum-h1");
    expect(stylesheet).toContain(".mum-link");
    expect(stylesheet).toContain(".mum-task-list");
    expect(stylesheet).not.toContain("@keyframes");
    expect(index).toContain('<h1 class="mum-heading mum-h1">Documentation Index</h1>');
    expect(index).toContain('<nav aria-label="Generated documentation">');
    expect(index).toContain('<a class="mum-link" href="DESIGN-MD.html">DESIGN-MD.html</a>');
    expect(index).toContain('<a class="mum-link" href="README.html">README.html</a>');
    expect(index).toContain('<a class="mum-link" href="docs/guide.html">docs/guide.html</a>');
    expect(index).not.toContain('<a href="index.html">index.html</a>');
    expect(index).not.toContain("stale.html");
    expect(index.indexOf('<h2 class="mum-heading mum-h2" id="section-1">Root</h2>')).toBeLessThan(
      index.indexOf('<h2 class="mum-heading mum-h2" id="section-2">docs</h2>'),
    );
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, DEFAULT_DESIGN_FILE.replace(".md", ".html")), "utf8")).resolves.toContain(
      '<h1 class="mum-heading mum-h1">Basic Docs</h1>',
    );
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "agents.html"), "utf8")).resolves.toContain(
      '<h1 class="mum-heading mum-h1">Agents</h1>',
    );
    const nestedHtml = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "docs", "guide.html"), "utf8");
    expect(nestedHtml).toContain('<link rel="stylesheet" href="../style.css">');
    expect(nestedHtml).toContain('<h1 class="mum-heading mum-h1">Guide</h1>');

    await writeFile(path.join(cwd, "README.md"), "# Project\n\nUpdated content.\n", "utf8");
    await renderProject({ cwd });
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "README.html"), "utf8")).resolves.toContain(
      "Updated content.",
    );
  });

  it("falls back to sorted visible Markdown files and excludes hidden, dependency, git, and output files", async () => {
    const cwd = await tempProject();
    await writeFile(path.join(cwd, DEFAULT_DESIGN_FILE), STARTER_DESIGN_MD, "utf8");
    await writeFile(path.join(cwd, "b.md"), "# B\n", "utf8");
    await writeFile(path.join(cwd, "a.md"), "# A\n", "utf8");
    await mkdir(path.join(cwd, "docs"));
    await writeFile(path.join(cwd, "docs", "guide.md"), "# Guide\n", "utf8");
    await writeFile(path.join(cwd, ".hidden.md"), "# Hidden\n", "utf8");
    await mkdir(path.join(cwd, ".hidden"));
    await writeFile(path.join(cwd, ".hidden", "nested.md"), "# Hidden Nested\n", "utf8");
    await mkdir(path.join(cwd, "node_modules"));
    await writeFile(path.join(cwd, "node_modules", "dependency.md"), "# Dependency\n", "utf8");
    await mkdir(path.join(cwd, ".git"));
    await writeFile(path.join(cwd, ".git", "ignored.md"), "# Git\n", "utf8");
    await mkdir(path.join(cwd, DEFAULT_OUTPUT_DIR));
    await writeFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "generated.md"), "# Generated\n", "utf8");

    const result = await renderProject({ cwd });

    expect(result.generated).toEqual([
      ".make-up-markdown/style.css",
      ".make-up-markdown/DESIGN-MD.html",
      ".make-up-markdown/a.html",
      ".make-up-markdown/b.html",
      ".make-up-markdown/docs/guide.html",
      ".make-up-markdown/index.html",
    ]);
    const index = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "index.html"), "utf8");
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "a.html"), "utf8")).resolves.toContain(
      '<h1 class="mum-heading mum-h1">A</h1>',
    );
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "b.html"), "utf8")).resolves.toContain(
      '<h1 class="mum-heading mum-h1">B</h1>',
    );
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "docs", "guide.html"), "utf8")).resolves.toContain(
      '<h1 class="mum-heading mum-h1">Guide</h1>',
    );
    expect(index).toContain('<a class="mum-link" href="DESIGN-MD.html">DESIGN-MD.html</a>');
    expect(index).toContain('<a class="mum-link" href="a.html">a.html</a>');
    expect(index).toContain('<a class="mum-link" href="b.html">b.html</a>');
    expect(index).toContain('<a class="mum-link" href="docs/guide.html">docs/guide.html</a>');
    expect(index).not.toContain(".hidden.html");
    expect(index).not.toContain("dependency.html");
    expect(index).not.toContain("generated.html");
  });

  it("removes generated HTML recursively when the corresponding Markdown source is removed", async () => {
    const cwd = await tempProject();
    await writeFile(path.join(cwd, DEFAULT_DESIGN_FILE), STARTER_DESIGN_MD, "utf8");
    await writeFile(path.join(cwd, "a.md"), "# A\n", "utf8");
    await mkdir(path.join(cwd, "docs"));
    await writeFile(path.join(cwd, "docs", "b.md"), "# B\n", "utf8");

    await renderProject({ cwd });
    await rm(path.join(cwd, "docs", "b.md"));
    const result = await renderProject({ cwd });
    const outputNames = await readdir(path.join(cwd, DEFAULT_OUTPUT_DIR));
    const docsOutputNames = await readdir(path.join(cwd, DEFAULT_OUTPUT_DIR, "docs"));

    expect(result.generated).toEqual([
      ".make-up-markdown/style.css",
      ".make-up-markdown/DESIGN-MD.html",
      ".make-up-markdown/a.html",
      ".make-up-markdown/index.html",
    ]);
    expect(outputNames.sort()).toEqual(["DESIGN-MD.html", "a.html", "docs", "index.html", "style.css"]);
    expect(docsOutputNames).toEqual([]);
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "index.html"), "utf8")).resolves.not.toContain(
      "docs/b.html",
    );
  });

  it("renders only explicit Markdown inputs and leaves unrelated generated HTML in place", async () => {
    const cwd = await tempProject();
    await writeFile(path.join(cwd, DEFAULT_DESIGN_FILE), STARTER_DESIGN_MD, "utf8");
    await writeFile(path.join(cwd, "README.md"), "# Readme\n", "utf8");
    await writeFile(path.join(cwd, ".hidden.md"), "# Hidden\n", "utf8");
    await mkdir(path.join(cwd, "docs"));
    await writeFile(path.join(cwd, "docs", "guide.md"), "# Guide\n", "utf8");
    await mkdir(path.join(cwd, DEFAULT_OUTPUT_DIR));
    await writeFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "stale.html"), "stale", "utf8");

    const result = await renderProject({ cwd, inputs: ["docs/guide.md", ".hidden.md"] });

    expect(result.generated).toEqual([
      ".make-up-markdown/style.css",
      ".make-up-markdown/docs/guide.html",
      ".make-up-markdown/.hidden.html",
      ".make-up-markdown/index.html",
    ]);
    const index = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "index.html"), "utf8");
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "docs", "guide.html"), "utf8")).resolves.toContain(
      '<h1 class="mum-heading mum-h1">Guide</h1>',
    );
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, ".hidden.html"), "utf8")).resolves.toContain(
      '<h1 class="mum-heading mum-h1">Hidden</h1>',
    );
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "stale.html"), "utf8")).resolves.toBe("stale");
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "README.html"), "utf8")).rejects.toThrow();
    expect(index).toContain('<a class="mum-link" href=".hidden.html">.hidden.html</a>');
    expect(index).toContain('<a class="mum-link" href="docs/guide.html">docs/guide.html</a>');
    expect(index).toContain('<a class="mum-link" href="stale.html">stale.html</a>');
    expect(index).not.toContain("README.html");
  });

  it("rejects explicit inputs that are missing, not Markdown, or outside the project", async () => {
    const cwd = await tempProject();
    await writeFile(path.join(cwd, DEFAULT_DESIGN_FILE), STARTER_DESIGN_MD, "utf8");
    await writeFile(path.join(cwd, "notes.txt"), "Not Markdown\n", "utf8");
    const outsideDir = await tempProject();
    const outsidePath = path.join(outsideDir, "outside.md");
    await writeFile(outsidePath, "# Outside\n", "utf8");

    await expect(renderProject({ cwd, inputs: ["missing.md"] })).rejects.toThrow(
      'Markdown input "missing.md" was not found.',
    );
    await expect(renderProject({ cwd, inputs: ["notes.txt"] })).rejects.toThrow(
      'Markdown input "notes.txt" is not a Markdown file.',
    );
    await expect(renderProject({ cwd, inputs: [outsidePath] })).rejects.toThrow(
      `Markdown input "${outsidePath}" must be inside the project.`,
    );
  });

  it("embeds supported local images relative to each Markdown file as data URLs", async () => {
    const cwd = await tempProject();
    await writeFile(path.join(cwd, DEFAULT_DESIGN_FILE), STARTER_DESIGN_MD, "utf8");
    await mkdir(path.join(cwd, "docs", "assets"), { recursive: true });
    await writeFile(path.join(cwd, "docs", "guide.md"), "# Image\n\n![pixel](assets/pixel.png)\n", "utf8");
    await writeFile(path.join(cwd, "docs", "assets", "pixel.png"), tinyPng(), "base64");

    const result = await renderProject({ cwd });
    const html = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "docs", "guide.html"), "utf8");

    expect(result.generated).toEqual([
      ".make-up-markdown/style.css",
      ".make-up-markdown/DESIGN-MD.html",
      ".make-up-markdown/docs/guide.html",
      ".make-up-markdown/index.html",
    ]);
    expect(result.warnings).toEqual([]);
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).not.toContain("assets/pixel.png");
  });

  it("generates and links Mermaid assets only for Mermaid diagrams and removes them when no longer needed", async () => {
    const cwd = await tempProject();
    await writeFile(path.join(cwd, DEFAULT_DESIGN_FILE), STARTER_DESIGN_MD, "utf8");
    await mkdir(path.join(cwd, "docs"));
    await writeFile(
      path.join(cwd, "README.md"),
      "# Root Flow\n\n```mermaid\nflowchart TD\nA-->B\n```\n",
      "utf8",
    );
    await writeFile(
      path.join(cwd, "docs", "sequence.md"),
      "# Nested Sequence\n\n```mermaid\nsequenceDiagram\nBob->>Alice: Hi\n```\n",
      "utf8",
    );

    const first = await renderProject({ cwd });
    const rootHtml = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "README.html"), "utf8");
    const nestedHtml = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "docs", "sequence.html"), "utf8");
    const designHtml = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "DESIGN-MD.html"), "utf8");

    expect(first.generated).toEqual([
      ".make-up-markdown/style.css",
      ".make-up-markdown/mermaid.min.js",
      ".make-up-markdown/mermaid-init.js",
      ".make-up-markdown/DESIGN-MD.html",
      ".make-up-markdown/README.html",
      ".make-up-markdown/docs/sequence.html",
      ".make-up-markdown/index.html",
    ]);
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "mermaid.min.js"), "utf8")).resolves.toContain(
      "mermaid",
    );
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "mermaid-init.js"), "utf8")).resolves.toContain(
      'securityLevel: "strict"',
    );
    expect(rootHtml).toContain('<script defer src="mermaid.min.js"></script>');
    expect(rootHtml).toContain('<script defer src="mermaid-init.js"></script>');
    expect(nestedHtml).toContain('<script defer src="../mermaid.min.js"></script>');
    expect(nestedHtml).toContain('<script defer src="../mermaid-init.js"></script>');
    expect(designHtml).not.toContain("mermaid.min.js");

    await writeFile(path.join(cwd, "README.md"), "# Root\n\nNo diagrams.\n", "utf8");
    await writeFile(path.join(cwd, "docs", "sequence.md"), "# Nested\n\nNo diagrams.\n", "utf8");

    const second = await renderProject({ cwd });
    const outputNames = await readdir(path.join(cwd, DEFAULT_OUTPUT_DIR));
    const rootHtmlAgain = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "README.html"), "utf8");

    expect(second.generated).toEqual([
      ".make-up-markdown/style.css",
      ".make-up-markdown/DESIGN-MD.html",
      ".make-up-markdown/README.html",
      ".make-up-markdown/docs/sequence.html",
      ".make-up-markdown/index.html",
    ]);
    expect(outputNames).not.toContain("mermaid.min.js");
    expect(outputNames).not.toContain("mermaid-init.js");
    expect(rootHtmlAgain).not.toContain("mermaid.min.js");
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "mermaid.min.js"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "mermaid-init.js"), "utf8")).rejects.toThrow();
  });

  it("renders flowchart Mermaid fences as diagram containers without warnings", async () => {
    const html = makeUpMarkdown("```mermaid\nflowchart TD\nA-->B\n```\n");
    expect(html).toContain('<pre class="mum-mermaid mermaid">');
    expect(html).toContain("flowchart TD");
    expect(html).not.toContain("mum-code-block-code language-mermaid");

    const cwd = await tempProject();
    await writeFile(path.join(cwd, DEFAULT_DESIGN_FILE), STARTER_DESIGN_MD, "utf8");
    await writeFile(path.join(cwd, "README.md"), "# Flow\n\n```mermaid\nflowchart TD\nA-->B\n```\n", "utf8");

    const result = await renderProject({ cwd });
    const renderedHtml = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "README.html"), "utf8");

    expect(result.generated).toContain(".make-up-markdown/mermaid.min.js");
    expect(result.generated).toContain(".make-up-markdown/mermaid-init.js");
    expect(result.warnings).toEqual([]);
    expect(renderedHtml).toContain('<pre class="mum-mermaid mermaid">');
    expect(renderedHtml).not.toContain("mum-code-block-code language-mermaid");
  });

  it("renders Markdown elements with semantic mum classes and GFM behavior", () => {
    const html = makeUpMarkdown(`# Heading

## Subheading

### Detail

Paragraph with [link](https://example.com), ![alt text](image.png), \`inline\`, ~~old~~, and https://example.org.

- one
- [x] done
- [ ] todo

1. first

> quote

\`\`\`ts
const value = 1;
\`\`\`

| Name | Value |
| --- | --- |
| A | B |

---
`);

    expect(html).toContain('<h1 class="mum-heading mum-h1">Heading</h1>');
    expect(html).toContain('<h2 class="mum-heading mum-h2">Subheading</h2>');
    expect(html).toContain('<h3 class="mum-heading mum-h3">Detail</h3>');
    expect(html).toContain('<p class="mum-paragraph">Paragraph with ');
    expect(html).toContain('<a href="https://example.com" class="mum-link">link</a>');
    expect(html).toContain('<img src="image.png" alt="alt text" class="mum-image">');
    expect(html).toContain('<code class="mum-code mum-code-inline">inline</code>');
    expect(html).toContain('<s class="mum-strikethrough">old</s>');
    expect(html).toContain('<a href="https://example.org" class="mum-link">https://example.org</a>');
    expect(html).toContain('<ul class="contains-task-list mum-list mum-ul mum-task-list">');
    expect(html).toContain('<li class="mum-list-item">one</li>');
    expect(html).toContain('<li class="task-list-item mum-list-item mum-task-list-item">');
    expect(html).toContain('class="task-list-item-checkbox mum-task-list-checkbox" checked="" disabled="" type="checkbox"');
    expect(html).toContain('class="task-list-item-checkbox mum-task-list-checkbox" disabled="" type="checkbox"');
    expect(html).toContain('<ol class="mum-list mum-ol">');
    expect(html).toContain('<blockquote class="mum-blockquote">');
    expect(html).toContain('<pre class="mum-code-block"><code class="mum-code mum-code-block-code language-ts">');
    expect(html).toContain('<table class="mum-table">');
    expect(html).toContain('<th class="mum-table-cell mum-table-header">Name</th>');
    expect(html).toContain('<td class="mum-table-cell">A</td>');
    expect(html).toContain('<hr class="mum-hr">');
  });

  it("hides managed annotation blocks from rendered Markdown fragments", () => {
    const html = makeUpMarkdown(`Paragraph.

<!-- mum-annotation:start id="anno-1" -->
> [!NOTE]
> Annotation on: "Paragraph."
> Browser note
<!-- mum-annotation:end -->
`);

    expect(html).toContain('<p class="mum-paragraph">Paragraph.</p>');
    expect(html).not.toContain('<blockquote class="mum-blockquote">');
    expect(html).not.toContain("Browser note");
    expect(html).not.toContain("mum-annotation:start");
    expect(html).not.toContain("mum-annotation:end");
  });

  it("renders Mermaid fences as browser-renderable diagram containers", () => {
    const sequenceHtml = makeUpMarkdown("```mermaid\n%% comment\n\nsequenceDiagram\nAlice->>Bob: <hello & goodbye>\n```\n");
    const flowchartHtml = makeUpMarkdown("```mermaid\nflowchart TD\nA-->B\n```\n");

    expect(sequenceHtml).toContain('<pre class="mum-mermaid mermaid">');
    expect(sequenceHtml).toContain("sequenceDiagram\nAlice-&gt;&gt;Bob: &lt;hello &amp; goodbye&gt;");
    expect(sequenceHtml).not.toContain("mum-code-block-code language-mermaid");
    expect(flowchartHtml).toContain('<pre class="mum-mermaid mermaid">');
    expect(flowchartHtml).toContain("flowchart TD\nA--&gt;B");
    expect(flowchartHtml).not.toContain("mum-code-block-code language-mermaid");
  });

  it("warns when supported local images cannot be embedded and unsupported images are referenced", async () => {
    const cwd = await tempProject();
    await writeFile(path.join(cwd, DEFAULT_DESIGN_FILE), STARTER_DESIGN_MD, "utf8");
    await writeFile(
      path.join(cwd, "README.md"),
      "# Images\n\n![missing](missing.png)\n\n![unsupported](icon.bmp)\n",
      "utf8",
    );

    const result = await renderProject({ cwd });
    const html = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "README.html"), "utf8");

    expect(result.warnings).toEqual([
      'README.md: local image "missing.png" could not be embedded.',
      'README.md: local image "icon.bmp" is not a supported embeddable type.',
    ]);
    expect(html).toContain('src="missing.png"');
    expect(html).toContain('src="icon.bmp"');
  });

  it("uses built-in defaults with a warning when the design file is missing or has no front matter", async () => {
    const missingDesign = await tempProject();
    await writeFile(path.join(missingDesign, "README.md"), "# Missing Design\n", "utf8");

    const missingResult = await renderProject({ cwd: missingDesign });

    expect(missingResult.warnings).toEqual([
      "DESIGN-MD.md was not found; using built-in design defaults.",
    ]);

    const noFrontMatter = await tempProject();
    await writeFile(path.join(noFrontMatter, DEFAULT_DESIGN_FILE), "# Design\n", "utf8");
    await writeFile(path.join(noFrontMatter, "README.md"), "# No Front Matter\n", "utf8");

    const noFrontMatterResult = await renderProject({ cwd: noFrontMatter });

    expect(noFrontMatterResult.warnings).toEqual([
      "DESIGN-MD.md has no YAML front matter; using built-in design defaults.",
    ]);
  });

  it("uses custom light theme tokens when provided by the design file", async () => {
    const cwd = await tempProject();
    await writeFile(
      path.join(cwd, DEFAULT_DESIGN_FILE),
      STARTER_DESIGN_MD.replace('primary: "#2563EB"', 'primary: "#0F766E"'),
      "utf8",
    );
    await writeFile(path.join(cwd, "README.md"), "# Custom Theme\n", "utf8");

    await renderProject({ cwd });

    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "style.css"), "utf8")).resolves.toContain(
      "--mum-primary-light: #0F766E;",
    );
  });

  it("fails clearly for malformed design front matter and empty projects", async () => {
    const malformed = await tempProject();
    await writeFile(path.join(malformed, DEFAULT_DESIGN_FILE), "---\ncolors:\n  - : bad\n---\n", "utf8");
    await writeFile(path.join(malformed, "README.md"), "# Bad Design\n", "utf8");

    await expect(renderProject({ cwd: malformed })).rejects.toThrow(
      /Failed to parse DESIGN-MD\.md YAML front matter:/,
    );

    const empty = await tempProject();

    await expect(renderProject({ cwd: empty })).rejects.toThrow(
      "No Markdown input files were found in the project.",
    );
  });
});

async function tempProject(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "make-up-markdown-"));
}

function tinyPng(): string {
  return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
}

async function fetchText(url: URL): Promise<string> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return response.text();
}

function postJson(url: URL, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchJson(url: URL, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
