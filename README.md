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

## File discovery

`GET /{token}/api/tree` returns a flat, path-sorted JSON list of every
eligible file and directory under the selected root (see `src/discovery.rs`).
Each entry has a `/`-separated `path` relative to the root, `is_dir`, and
`likely_secret`.

### What is excluded

- Anything matched by a `.gitignore` in the tree, respected regardless of
  whether the root is actually a git repository.
- `.git` itself, and a small baseline of common dependency/build directories
  that are excluded even without a `.gitignore`: `node_modules`, `target`,
  `dist`, `build`, `.venv`, `venv`, `__pycache__`, `.next`, `.nuxt`.
- Symlinks of any kind (files or directories). Symlinks are never followed
  and never listed, so a symlink cannot be used to read or list anything
  outside the selected root.
- Files that look binary: if a NUL byte appears in the first ~8000 bytes,
  the file is treated as binary and skipped. Files that can't be read (e.g.
  a permission error) are skipped the same way rather than failing the
  whole request.

Ordinary dotfiles and dotdirs (e.g. `.github`) are **not** excluded by
default; only `.gitignore` patterns and the baseline list above apply.

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