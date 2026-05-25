# make-up-markdown

Render local Markdown documentation into self-contained HTML presentations.

## Usage

```sh
npx -p make-up-markdown mum init
npx -p make-up-markdown mum render
npx -p make-up-markdown mum annotate
npx -p make-up-markdown mum sync
```

After a global install or `npm link`, the executable command is:

```sh
mum init
mum render
mum annotate
mum sync
```

`init` creates `.make-up-markdown/`, creates a starter `DESIGN-MD.md` when one is missing, and ensures `.make-up-markdown/` is listed in `.gitignore`.

`render` writes generated HTML to `.make-up-markdown/`. It renders visible Markdown files recursively by default, including `README.md`, `DESIGN-MD.md`, and nested files such as `docs/guide.md`. Hidden files and directories, dependency directories, Git metadata, and generated output are skipped.

To render only specific Markdown files, pass them as positional arguments:

```sh
mum render README.md docs/guide.md
```

Generated HTML includes inline CSS, preserves Markdown links and remote image URLs, and embeds supported local images as data URLs. Rendering is local and does not fetch remote resources.

`annotate` starts a local browser annotation server and prints its URL. It uses the same Markdown discovery and explicit file handling as `render`; pass files to limit the session, and use `--port <number>` when you need a specific local port.

```sh
mum annotate README.md docs/guide.md --port 5173
```

In annotation mode, select text inside one rendered Markdown block, click **Add annotation**, enter a note, and save. The server writes a managed callout directly back into the source Markdown file. Annotation mode does not expose an annotation JSON download or browser file-save prompt.

`sync` reads `.make-up-markdown/annotations.json` by default and inserts visible managed callouts into the referenced Markdown files. Pass a custom annotation file path as the first argument, or use `--dry-run` to report which Markdown files would change without writing them.

```json
{
  "version": 1,
  "annotations": [
    {
      "id": "anno-1",
      "source": "README.md",
      "blockStartLine": 12,
      "blockEndLine": 14,
      "quote": "selected text",
      "note": "User note"
    }
  ]
}
```

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
