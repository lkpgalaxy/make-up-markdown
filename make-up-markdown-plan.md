# make-up-markdown Package Plan

## Summary

`make-up-markdown` is a package and CLI for turning Markdown documentation into polished local HTML presentations. It should work deterministically, require no network calls during rendering, and produce output that can be opened directly from disk or committed as generated artifacts when desired.

The package centers on two commands:

- `make-up-markdown init`
- `make-up-markdown render`

The default output directory is `.make-up-markdown/`. During initialization, the CLI adds `.make-up-markdown/` to `.gitignore` so generated output stays out of source control unless the user intentionally changes that behavior.

## Key Changes

- Create a package and CLI named `make-up-markdown`.
- Provide an `init` command that prepares the local project for rendered Markdown output.
- Provide a `render` command that renders Markdown into self-contained HTML.
- Write generated output under `.make-up-markdown/` by default.
- Render deterministically from local Markdown to self-contained HTML.
- Reuse an existing `DESIGN-MD.md` file when present.
- Generate a Google `design.md` compatible starter `DESIGN-MD.md` during `init` when one does not already exist.
- Add `.make-up-markdown/` to `.gitignore` during `init`.
- Never modify Markdown input files such as `README.md`.
- Keep the first version focused on local, repeatable rendering instead of hosted publishing or remote design services.

## Public Interface

### Package Name

The package name is `make-up-markdown`.

### CLI Name

The executable command is `make-up-markdown`.

### Commands

#### `make-up-markdown init`

Initializes the current project for `make-up-markdown`.

Expected behavior:

- Create `.make-up-markdown/` if it does not exist.
- Detect whether `DESIGN-MD.md` exists in the project root.
- Reuse the existing `DESIGN-MD.md` when present.
- Generate a starter `DESIGN-MD.md` when missing, using Google `design.md` alpha format.
- Add `.make-up-markdown/` to `.gitignore` if it is not already ignored.
- Avoid overwriting existing user-authored files without explicit confirmation or a force option.
- Print a concise summary of created, reused, and updated files.

Optional future flags:

- `--force` to overwrite generated starter files where safe.
- `--output <dir>` to configure a non-default output directory.
- `--design <path>` to use a design file outside the project root.

#### `make-up-markdown render`

Renders Markdown files into self-contained HTML.

Expected behavior:

- Read Markdown input from the current project.
- By default, render `README.md` when it exists, without modifying it.
- If `README.md` is missing, render Markdown files in the project root.
- Exclude `DESIGN-MD.md`, files under `.make-up-markdown/`, dependency directories, hidden directories, and generated output.
- Use `DESIGN-MD.md` as the local design source.
- Produce deterministic HTML output in `.make-up-markdown/`.
- Produce one `.html` output per rendered Markdown file.
- Render `README.md` to `.make-up-markdown/README.html`.
- Render other root Markdown files to `.make-up-markdown/<markdown-file-name>.html`, for example `guide.md` to `.make-up-markdown/guide.html`.
- Refresh generated output on every render so `.make-up-markdown/` reflects the latest Markdown inputs.
- Remove stale generated HTML files that no longer correspond to current Markdown inputs.
- Inline required CSS so the rendered HTML has no generated sibling asset dependency.
- Preserve Markdown links in the generated HTML.
- Preserve remote image URLs in the generated HTML without fetching them during rendering.
- Embed local Markdown images as data URLs when supported, or emit warnings when they cannot be embedded.
- Avoid network requests during rendering.
- Produce stable output for the same Markdown, design source, package version, and options.
- Print generated file paths and any non-fatal warnings.

Optional future flags:

- `--input <path>` to render one Markdown file or a directory.
- `--output <dir>` to override `.make-up-markdown/`.
- `--design <path>` to override the design source.
- `--watch` to re-render during local editing.

### Output Directory

The default output directory is:

```text
.make-up-markdown/
```

Initial expected contents:

```text
.make-up-markdown/
  README.html
  guide.html
```

The exact internal layout may evolve, but the directory should remain safe to delete and regenerate. For v1, output HTML filenames should follow the source Markdown filenames.

For v1, each generated HTML file includes all required CSS inline and does not depend on generated sibling assets. Local images are embedded when supported. Remote links and remote image URLs are preserved exactly as authored; rendering does not fetch them, although opening the generated HTML in a browser may load remote image URLs.

Generated output should live under `.make-up-markdown/` in the project where the command is run. The package should not write generated HTML into the installed npm package directory.

### Rendering Model

Rendering should be deterministic and local:

- Markdown is parsed locally.
- HTML is generated locally.
- CSS is derived from local package defaults plus `DESIGN-MD.md`.
- Output should not depend on remote APIs, remote fonts, timestamps, hostnames, random IDs, dependency-order-sensitive traversal, or machine-specific absolute paths.
- Any generated IDs, anchors, output paths, embedded asset names, file discovery, and warning output should be stable for the same input.
- The output filename should preserve the Markdown basename and replace the extension with `.html`; for example, `my-guide.md` becomes `my-guide.html`.
- `render` should work without running `init`; when `DESIGN-MD.md` is missing, it should use built-in design defaults and print a warning.

The first implementation should prioritize correctness and repeatability over an expansive Markdown feature set. V1 targets CommonMark plus GitHub-flavored tables and fenced code blocks. Headings, links, images, tables, code blocks, and lists should be supported before custom extensions.

### Design Source

`DESIGN-MD.md` is the project-level design contract. It should follow the Google `design.md` alpha format so it remains useful outside this package.

Expected behavior:

- If `DESIGN-MD.md` exists, use it as the design source.
- If `DESIGN-MD.md` does not exist, `init` creates a starter file.
- The starter design should include YAML front matter first, followed by Markdown rationale.
- The YAML front matter should include `version`, `name`, `description`, `colors`, `typography`, `rounded`, `spacing`, and `components` tokens.
- Markdown sections should follow the canonical Google `design.md` order: `Overview`, `Colors`, `Typography`, `Layout`, `Elevation & Depth`, `Shapes`, `Components`, and `Do's and Don'ts`.
- The renderer should treat YAML front matter tokens as the normative implementation values.
- Markdown prose should provide human-readable guidance and fallback context, not a custom parser contract.
- Rendering should degrade gracefully if optional design details are missing.
- When `DESIGN-MD.md` has no YAML front matter, render with built-in defaults and print a warning.
- When `DESIGN-MD.md` has malformed YAML front matter, fail clearly and identify the design file.

The renderer should treat `DESIGN-MD.md` as user-owned project configuration, not as generated cache.

The generated starter file should be compatible with:

```sh
npx -y @google/design.md lint DESIGN-MD.md
```

The package may document this validation command, but rendering itself must not require network access or invoke remote tooling.

### Git Ignore Behavior

During `init`, ensure `.make-up-markdown/` is ignored by Git.

Expected behavior:

- Create `.gitignore` if the project does not have one.
- `init` may create `.gitignore` even when the current directory is not yet a Git repository, but it should print that no Git repository was detected.
- Append `.make-up-markdown/` only when it is not already covered by an existing ignore entry.
- Preserve existing `.gitignore` content and formatting as much as possible.
- Do not add duplicate ignore entries.

## Implementation Notes

- Keep command behavior small and predictable in the first release.
- Use structured Markdown parsing instead of ad hoc regular expressions for document conversion.
- Use a structured front matter parser for `DESIGN-MD.md` instead of scanning prose for tokens.
- Keep generated output disposable and reproducible.
- Treat generated HTML files in the output directory as managed artifacts that can be replaced on each render.
- Separate user-owned files from generated files.
- Make error messages specific enough to identify the failed file, command, or configuration value.
- Prefer explicit defaults over hidden inference.
- Support Node.js `>=20`.
- Expose the CLI through the npm `bin` field, for example `"make-up-markdown": "./dist/cli.js"`.
- Keep the CLI entrypoint separate from the library API, for example `src/cli.ts` plus `src/index.ts`.
- Embed the starter `DESIGN-MD.md` template in TypeScript for v1 so npm packaging does not depend on copying template files.
- Use dependencies deliberately:
  - CLI argument parsing: `commander`.
  - Markdown parsing/rendering: `markdown-it`.
  - Front matter parsing: `gray-matter`.
  - YAML parsing: `yaml`, directly or through `gray-matter`.
  - Tests: `vitest` plus temporary directory fixtures.

## Plan Validation

- Confirm `make-up-markdown-plan.md` exists.
- Confirm the plan contains the required sections:
  - `Summary`
  - `Key Changes`
  - `Public Interface`
  - `Plan Validation`
  - `Package Test Plan`
  - `Assumptions`
- Confirm the file does not include wrapper tags from the proposed-plan envelope.

## Package Test Plan

- For the future package implementation, test `init` in an empty project.
- Test `init` in a project that already has `DESIGN-MD.md`.
- Test `init` in a project that already has `.gitignore`.
- Test `init` in a directory without `.git/`.
- Test `init` does not duplicate `.make-up-markdown/` in `.gitignore`.
- Test generated starter `DESIGN-MD.md` follows Google `design.md` alpha front matter and section order.
- Test `render` defaults to `README.md` when it exists and does not modify it.
- Test `render` falls back to root Markdown files when `README.md` is missing.
- Test `render` excludes `DESIGN-MD.md`, hidden directories, dependency directories, and `.make-up-markdown/`.
- Test `render` produces `.make-up-markdown/README.html` for `README.md`.
- Test `render` produces `.make-up-markdown/<markdown-file-name>.html` for other root Markdown files.
- Test repeated `render` updates generated HTML to match current Markdown contents.
- Test removed Markdown inputs are no longer represented in generated output after render.
- Test Markdown links and remote image URLs are preserved without fetching remote resources.
- Test supported local images are embedded as data URLs.
- Test unsupported local images produce warnings.
- Test missing `DESIGN-MD.md` falls back to built-in defaults with a warning.
- Test malformed `DESIGN-MD.md` YAML fails clearly.
- Test repeated `render` runs produce stable output for unchanged inputs.
- Test rendering does not require network access.
- Test generated output is written under the current project output directory, not the installed package directory.
- Test CLI success exits `0` and invalid commands, invalid design front matter, no input files, and unwritable output directories exit non-zero.
- Test clear failures for missing input files, invalid design files, and unwritable output directories.

## Assumptions

- `make-up-markdown-plan.md` should be created as a new file rather than appended to an existing file.
- The file should contain the package plan only, not implementation code.
- The selected package and CLI name is `make-up-markdown`.
- The selected commands are `init` and `render`.
- The selected output directory is `.make-up-markdown/`.
- Rendering is deterministic local Markdown to one local `.html` file per Markdown input file.
- The design source is Google `design.md` compatible `DESIGN-MD.md`, reused when present and generated during `init` when missing.
- `.make-up-markdown/` is added to `.gitignore` during `init`.
- Runtime support starts at Node.js `>=20`.
