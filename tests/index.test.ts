import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DESIGN_FILE,
  DEFAULT_OUTPUT_DIR,
  STARTER_DESIGN_MD,
  initProject,
  renderProject,
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

describe("renderProject", () => {
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
    const before = await readFile(path.join(cwd, "README.md"), "utf8");

    const first = await renderProject({ cwd });
    const html = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "README.html"), "utf8");
    const second = await renderProject({ cwd });
    const htmlAgain = await readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "README.html"), "utf8");
    const outputNames = await readdir(path.join(cwd, DEFAULT_OUTPUT_DIR));

    expect(first.generated).toEqual([
      ".make-up-markdown/DESIGN-MD.html",
      ".make-up-markdown/README.html",
      ".make-up-markdown/agents.html",
      ".make-up-markdown/docs/guide.html",
    ]);
    expect(second.generated).toEqual([
      ".make-up-markdown/DESIGN-MD.html",
      ".make-up-markdown/README.html",
      ".make-up-markdown/agents.html",
      ".make-up-markdown/docs/guide.html",
    ]);
    expect(html).toBe(htmlAgain);
    expect(await readFile(path.join(cwd, "README.md"), "utf8")).toBe(before);
    expect(html).toContain('<a href="docs/guide.md">guide</a>');
    expect(html).toContain('<img src="https://example.com/image.png" alt="remote">');
    expect(html).toContain("<style>");
    expect(html).not.toContain('rel="stylesheet"');
    expect(outputNames.sort()).toEqual(["DESIGN-MD.html", "README.html", "agents.html", "docs"]);
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, DEFAULT_DESIGN_FILE.replace(".md", ".html")), "utf8")).resolves.toContain(
      "<h1>Make Up Markdown Starter</h1>",
    );
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "agents.html"), "utf8")).resolves.toContain(
      "<h1>Agents</h1>",
    );
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "docs", "guide.html"), "utf8")).resolves.toContain(
      "<h1>Guide</h1>",
    );

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
      ".make-up-markdown/DESIGN-MD.html",
      ".make-up-markdown/a.html",
      ".make-up-markdown/b.html",
      ".make-up-markdown/docs/guide.html",
    ]);
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "a.html"), "utf8")).resolves.toContain("<h1>A</h1>");
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "b.html"), "utf8")).resolves.toContain("<h1>B</h1>");
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "docs", "guide.html"), "utf8")).resolves.toContain(
      "<h1>Guide</h1>",
    );
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

    expect(result.generated).toEqual([".make-up-markdown/DESIGN-MD.html", ".make-up-markdown/a.html"]);
    expect(outputNames.sort()).toEqual(["DESIGN-MD.html", "a.html", "docs"]);
    expect(docsOutputNames).toEqual([]);
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
      ".make-up-markdown/docs/guide.html",
      ".make-up-markdown/.hidden.html",
    ]);
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "docs", "guide.html"), "utf8")).resolves.toContain(
      "<h1>Guide</h1>",
    );
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, ".hidden.html"), "utf8")).resolves.toContain(
      "<h1>Hidden</h1>",
    );
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "stale.html"), "utf8")).resolves.toBe("stale");
    await expect(readFile(path.join(cwd, DEFAULT_OUTPUT_DIR, "README.html"), "utf8")).rejects.toThrow();
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

    expect(result.generated).toEqual([".make-up-markdown/DESIGN-MD.html", ".make-up-markdown/docs/guide.html"]);
    expect(result.warnings).toEqual([]);
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).not.toContain("assets/pixel.png");
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
