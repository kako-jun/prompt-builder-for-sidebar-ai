# API

`GET /{token}/api/root` returns the selected root's `basename` and resolved
`absolutePath` as JSON, so the frontend can present the root as the
explorer's top-level node without ever exposing a way to navigate above it.

`GET /{token}/api/tree` returns `{ entries, truncated }` as JSON (see
`src/discovery.rs`): `entries` is a flat, path-sorted list of every eligible
file and directory under the selected root, each with a `/`-separated `path`
relative to the root, `is_dir`, and `likely_secret`. The walk is capped at
50,000 *visited* items (`discovery::MAX_TREE_ENTRIES`) as a
resource-exhaustion backstop against a pathological tree -- counting every
item the walk looks at, not just the ones that end up in `entries`, so a
tree dominated by filtered-out items (an enormous number of symlinks, or
binaries, since checking one means opening and reading it) can't blow
through the cap for free. `truncated` is `true` when that cap was actually
hit, so the response never silently looks complete when it isn't -- the
explorer UI shows a warning above the file tree in that case. Which entries
survive a truncation is deterministic (name-sorted per directory during the
walk itself), not dependent on unspecified filesystem enumeration order.
Ordinary projects never come close to the cap.

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
uses (both endpoints call the same `discovery::resolve_regular_file`
helper). A missing/empty `path` query returns 400. Escaping the root,
passing through a symlink, not existing, or being a directory all return
404 -- merged into a single status so this endpoint can never be used to
tell whether something exists outside the selected root (it never returns
403). A file larger than 10 MiB (`discovery::MAX_SERVABLE_FILE_SIZE`, the
same resource-exhaustion backstop `api/tree`'s entry cap is) returns 400. A
binary file (by the same NUL-sniffing heuristic `api/tree` uses) returns
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

## What is excluded

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

## Secret files are flagged, not hidden

Files whose names commonly hold secrets are still included in the tree, but
marked `likely_secret: true` so the frontend can warn before they are used:
`.env` and `.env.*`, `*.pem`/`*.key`/`*.pfx`/`*.p12`/`*.jks`, typical
extension-less SSH key names (`id_rsa`, `id_ed25519`, ...), `.npmrc`, and
`.netrc`.

## Known limitations

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
  the "Selection size statistics" section of [EXPLORER_UI.md](EXPLORER_UI.md)
  for why.
