# Explorer UI

The session page (`GET /{token}`) is a two-pane explorer: a resizable left
pane with the file tree, selection presets, a path filter, and a recently
opened list; a right pane that renders every checked file's content as its
own collapsible panel. It defaults to a dark theme and is implemented as
plain HTML/CSS/JS (`assets/index.html`, `assets/style.css`, `assets/app.js`,
all embedded in the binary at build time) with no external network
dependency and no build step. A persistent notice at the top of the page
restates this README's disclaimer: content copied from here may be pasted
into a third-party AI, and file content can carry prompt-injection text.

## Line numbers, stable references, and URL navigation

Each open file panel shows 1-based line numbers down its left edge; they are
excluded from text selection, so dragging across the code to copy it never
picks up the line numbers themselves. Clicking a line number selects that
single line; Shift-clicking extends the selection to a range from the last
plain click.

Every file panel's heading always shows its stable `@file:<path>` reference,
and while a line range is selected the panel also shows the matching
`@lines:<path>#L<start>-L<end>` reference (a single selected line omits the
`-L<end>` part, e.g. `@lines:src/app.js#L42`). A directory's reference
(shown when navigated to, see below) is `@dir:<path>`.

These reference strings double as the page's URL fragment: `location.hash`
holds one, percent-encoded, so the current directory or line selection can be
bookmarked or shared as a link. Loading a URL with an `@dir:` fragment
expands and scrolls the file tree to that directory; an `@file:`/`@lines:`
fragment scrolls to and briefly highlights the matching already-open file
panel (applying the line selection first, for `@lines:`). Opening a file
automatically from a fragment is out of scope: if the file isn't open yet,
an `@file:`/`@lines:` fragment is a no-op.

## Copy actions and output formats

Every place content can be copied -- a file panel's header, a directory row
in the tree (hover to reveal), and the content pane's global toolbar -- shows
the same control: an always-visible primary button plus a "⋯" button that
opens a menu of the other output formats and actions (a reference-only copy,
and, once a line range is selected, a reference-plus-code copy). The primary
button always copies as Markdown; the "⋯" menu covers the rest.

There are four output formats:

- **plain**: a path heading, an underline, and the file's content verbatim.
  The minimal format -- file boundaries between multiple files are only as
  unambiguous as a human reading the headings makes them.
- **markdown**: a `### <path>` heading followed by a fenced code block
  (escalating the fence length whenever the content itself contains
  backticks that would otherwise close it early).
- **xml**: a `<file path="...">...</file>` element (multi-file copies are
  wrapped in a single `<files>`). This isn't decoration -- it exists so an AI
  reading multiple concatenated files can't mistake where one file's content
  ends and the next one's path begins, something plain/markdown headings
  alone can't fully guarantee.
- **diff**: deliberately almost identical to plain for now. A future issue
  will feed a real `git diff` through this same slot; today it's just a
  correct receptacle for that content, not a synthesized fake diff.

A successful or failed copy is reflected right on the button that triggered
it (a transient "Copied!"/"Copy failed" label). A multi-file copy re-fetches
every file's content before writing to the clipboard, which can take long
enough that an unrelated re-render (e.g. toggling a checkbox) removes that
button from the page first; when that happens, the same feedback appears
instead as a toast notification in the corner of the page, so the result is
never silently lost.

## Prompt composer

A collapsible "Prompt composer" panel sits at the top of the content pane.
It builds an editable prompt from four choices, plus optional free-form
instructions, matching the goal/target/output/context-mode model from the
project's design:

- **Goal**: find relevant code, explain code, investigate a bug or its
  impact, review design or security, extract test cases, suggest
  refactoring, or plan implementation.
- **Target**: the whole page, the checked files, the currently selected line
  range(s), or the Git diff. Choosing "Downloadable file" as the output also
  reveals a filename field, whose value is embedded in the prompt as an
  explicit "generate a downloadable file named `<name>`" instruction (falling
  back to `output.md` if left blank).
- **Output**: concise answer, investigation report, GitHub issue,
  implementation instructions, checklist, unified diff, or a downloadable
  file.
- **Context mode**: "Page context only" generates just the prompt text,
  relying on the sidebar AI reading the live page itself; "Referenced
  excerpts" embeds the currently selected line range(s) from every file with
  an active selection; "Full selected files" embeds the full content of every
  checked file.

Every combination of these four choices produces a complete, readable prompt
-- including edge cases like "Referenced excerpts" with nothing currently
selected, which embeds an explanatory placeholder instead of silently
omitting the context section. Target "Git diff" embeds the current diff (via
`GET /{token}/api/diff`, see [API.md](API.md)) under the "## Context" heading
for "Referenced excerpts"/"Full selected files" (there's no separate "just an
excerpt of the diff" mode -- a diff is already a purpose-built excerpt of the
changes, so both behave the same for this target). "Page context only" is
honored, not overridden: unlike every other target, a diff is never actually
rendered anywhere on the page for a sidebar AI to read on its own, so the
usual "just read the live page" assumption doesn't hold for it -- rather than
silently embedding the diff anyway (uncommitted changes routinely contain
secrets or work-in-progress code a user may deliberately not want handed to a
third-party AI), the Context section explains that and suggests switching
context mode. If the selected root isn't a Git repository, or there are no
local changes, it says that in plain language instead, in either case never
appearing empty or broken.

Clicking "Generate prompt" (re)writes the result textarea from the current
choices; the result is otherwise freely editable, and "Copy prompt" always
copies whatever is currently in that textarea (including manual edits), not
a freshly regenerated version.

## Selection size statistics

The content toolbar shows, next to the open-file count, a live line of
statistics for the currently checked selection: file count, total character
count, and an estimated token count, updating as files are checked/unchecked
and as each one's content finishes loading (a checked-but-still-loading file
counts toward the file count immediately but not yet toward the character
count, and is called out explicitly, e.g. "3 files selected (1 still
loading)", rather than silently under-reporting the total). Past roughly
200,000 characters the line also gets a "⚠ large selection" warning -- a
soft, order-of-magnitude heuristic meant to catch an accidental
"select-everything", not a hard limit enforced anywhere.

The token count is deliberately labeled "(rough estimate)": it is computed as
`characters ÷ 4`, a widely-used approximation for English-ish source/prose
text, not a real tokenizer for any specific model. This tool is vendor-neutral
and has no access to (and makes no attempt to replicate) any particular AI
provider's actual tokenizer, so the estimate can be meaningfully off --
especially for text that isn't English-like prose (dense symbolic code,
non-Latin scripts, minified/generated files) -- and should be read as an
order-of-magnitude sense of size, not a precise count.
