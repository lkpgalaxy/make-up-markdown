# make-up-markdown

Render local Markdown documentation into self-contained HTML presentations.

## Usage

```sh
npx -p make-up-markdown mum init
npx -p make-up-markdown mum render
```

After a global install or `npm link`, the executable command is:

```sh
mum init
mum render
```

`init` creates `.make-up-markdown/`, creates a starter `DESIGN-MD.md` when one is missing, and ensures `.make-up-markdown/` is listed in `.gitignore`.

`render` writes generated HTML to `.make-up-markdown/`. It renders visible Markdown files recursively by default, including `README.md`, `DESIGN-MD.md`, and nested files such as `docs/guide.md`. Hidden files and directories, dependency directories, Git metadata, and generated output are skipped.

To render only specific Markdown files, pass them as positional arguments:

```sh
mum render README.md docs/guide.md
```

Generated HTML includes inline CSS, preserves Markdown links and remote image URLs, and embeds supported local images as data URLs. Rendering is local and does not fetch remote resources.

## Design

`DESIGN-MD.md` is the project design source. The starter file uses the Google `design.md` alpha format: YAML front matter first, followed by the canonical Markdown section order.

You can validate the starter or your edited design file with:

```sh
npx -y @google/design.md lint DESIGN-MD.md
```

The renderer uses YAML front matter tokens as implementation values. If `DESIGN-MD.md` is missing or has no front matter, it falls back to built-in defaults and prints a warning. Malformed front matter fails the render with a clear error.

## Development

```sh
npm run build
npm run typecheck
npm test
```
