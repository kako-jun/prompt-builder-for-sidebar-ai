# prompt-builder-for-sidebar-ai

A local browser that builds prompts for sidebar AI from your files.

## Usage

```console
cargo run -- [ROOT]
```

- `ROOT` is an optional directory to serve; it defaults to the current directory (`.`).
- The root must exist and be a directory; otherwise the command prints an error and exits non-zero.
- The server binds to an available port on `127.0.0.1` only (loopback, no external exposure).
- An unguessable session URL (`http://127.0.0.1:<port>/<token>`) is printed and opened in your default browser. Only that exact path responds; every other path returns 404.
- Press Ctrl+C to shut the server down cleanly.

Example:

```console
cargo run -- .
cargo run -- ~/repos/my-project
```

## Explorer UI

The session page (`GET /{token}`) is a two-pane explorer: a resizable left
pane with the file tree, selection presets, a path filter, and a recently
opened list; a right pane that renders every checked file's content as its
own collapsible panel. It defaults to a dark theme and is implemented as
plain HTML/CSS/JS (`assets/index.html`, `assets/style.css`, `assets/app.js`,
all embedded in the binary at build time) with no external network
dependency and no build step.

### Line numbers, stable references, and URL navigation

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

### Copy actions and output formats

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

### Prompt composer

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
`GET /{token}/api/diff`, see below) under the "## Context" heading for
"Referenced excerpts"/"Full selected files" (there's no separate "just an
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

### Selection size statistics

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

## API

`GET /{token}/api/root` returns the selected root's `basename` and resolved
`absolutePath` as JSON, so the frontend can present the root as the
explorer's top-level node without ever exposing a way to navigate above it.

`GET /{token}/api/tree` returns a flat, path-sorted JSON list of every
eligible file and directory under the selected root (see `src/discovery.rs`).
Each entry has a `/`-separated `path` relative to the root, `is_dir`, and
`likely_secret`.

`GET /{token}/api/file?path=<relative path>` returns one file's content as
`text/plain; charset=utf-8`. This is the most security-sensitive endpoint in
the app: the requested path is validated one path component at a time,
starting from the canonicalized root. Any component that isn't a plain name
(a `..`, a leading `/`, or a `.`) is rejected immediately, before the
filesystem is ever touched; each remaining component is then checked with
`symlink_metadata` to make sure it isn't a symlink. This means `../`
traversal, an absolute-path query value, and a symlink anywhere in the path
(whether it points outside the root or stays inside it) are all refused,
matching the same "never follow a symlink" invariant `api/tree` already
uses. A missing/empty `path` query returns 400. Escaping the root, passing
through a symlink, not existing, or being a directory all return 404 --
merged into a single status so this endpoint can never be used to tell
whether something exists outside the selected root (it never returns 403).
A binary file (by the same NUL-sniffing heuristic `api/tree` uses) returns
400; content that isn't valid UTF-8 also returns 400. A file that passes
every check but still can't be read (e.g. a permission error) returns 500.

`GET /{token}/api/diff` returns the selected root's current Git diff as JSON:
`isGitRepo` (whether the root is inside a Git working tree at all -- `false`
covers both "not a Git repository" and "the `git` binary isn't installed",
which this endpoint deliberately can't tell apart, since either way there is
simply no diff to show) and `diff` (the diff text, or `""` when there's
nothing to show). The diff combines tracked changes -- staged and unstaged,
via `git diff HEAD` -- with untracked files, which `git diff` never includes
by default: each untracked file is validated first (the same
symlink-refusing, binary-skipping path check `api/file` uses, via a shared
`discovery::resolve_regular_file` helper both endpoints call), then handed to
`git diff --no-index -- /dev/null <path>` so Git itself produces the "new
file" block -- correct mode bits (an executable untracked script is reported
as `100755`, not a hardcoded `100644`), the `\ No newline at end of file`
marker, and no hunk at all for a genuinely empty file -- rather than a
hand-rolled approximation of Git's own output format. This endpoint never
mutates the repository -- no `git add`, no staging, no commits -- and never
errors for a non-Git root or a repository with no commits yet; both degrade
to an empty (or partial, for the no-commits + untracked-files case) diff
rather than a failure response. Output is decoded permissively (invalid
UTF-8 bytes become replacement characters rather than failing outright), so
one file with unusual encoding can never cause every other, perfectly valid
file's diff to silently disappear from the response. See `src/diff.rs` for
the exact command sequence and edge cases (modified/added/deleted/untracked
files, an empty repository, a non-Git directory).

### What is excluded

- Anything matched by a `.gitignore` in the tree, respected regardless of
  whether the root is actually a git repository.
- `.git` itself, and a small baseline of common dependency/build directories
  that are excluded even without a `.gitignore`: `node_modules`, `target`,
  `dist`, `build`, `.venv`, `venv`, `__pycache__`, `.next`, `.nuxt`.
- Symlinks of any kind (files or directories). Symlinks are never followed
  and never listed, so a symlink cannot be used to read or list anything
  outside the selected root.
- Non-regular files: named pipes (FIFOs), character/block devices, sockets,
  and anything else that is neither a directory nor a regular file. These
  are skipped without ever being opened, since opening one (e.g. a FIFO
  with no writer on the other end) can block indefinitely.
- Files that look binary: if a NUL byte appears in the first ~8000 bytes,
  the file is treated as binary and skipped. Files that can't be read (e.g.
  a permission error) are skipped the same way rather than failing the
  whole request.

Ordinary dotfiles and dotdirs (e.g. `.github`) are **not** excluded by
default; only `.gitignore` patterns and the baseline list above apply.

Binary detection is evaluated before the secret-file check below, so a
binary-format key file (`.pfx`/`.p12`/`.jks`, ...) is excluded outright as
binary and never gets a chance to be flagged as `likely_secret`. This is
considered to satisfy the "exclude" arm of issue #3's acceptance criterion
("Exclude or visibly flag likely secret files").

### Secret files are flagged, not hidden

Files whose names commonly hold secrets are still included in the tree, but
marked `likely_secret: true` so the frontend can warn before they are used:
`.env` and `.env.*`, `*.pem`/`*.key`/`*.pfx`/`*.p12`/`*.jks`, typical
extension-less SSH key names (`id_rsa`, `id_ed25519`, ...), `.npmrc`, and
`.netrc`.

### Known limitations

- The baseline excluded-directory list and the secret-file name list above
  are small, hand-picked sets, not exhaustive detection. A project-specific
  `.gitignore` is the primary defense against exposing files that shouldn't
  be browsed; more thorough secret detection is tracked separately.
- Binary detection is a heuristic (NUL byte in a small prefix), the same
  kind git itself uses; it is not a guarantee for every file format.
- `api/diff` shells out to the `git` binary on `PATH`; it must be installed
  for diff support to work (a missing binary degrades to `isGitRepo: false`
  rather than an error, so the rest of the tool is unaffected). A repository
  with no commits yet that also has something staged (`git add`ed before the
  first commit) is a known gap: `git diff HEAD` has no `HEAD` to compare
  against and is skipped entirely in that case, and a staged (not merely
  untracked) file doesn't show up in the untracked-file listing either --
  the change would be silently missing from the diff until after the first
  commit.
- Untracked-file diffing shells out to `git diff --no-index -- /dev/null
  <path>`, which assumes a Unix-like environment (the rest of this codebase
  makes the same implicit assumption already -- there is no Windows CI
  runner and no Windows-specific handling elsewhere).
- The token count shown next to the selection size statistics is a rough
  `characters ÷ 4` estimate, not a real tokenizer for any specific model; see
  the "Selection size statistics" section above for why.