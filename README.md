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