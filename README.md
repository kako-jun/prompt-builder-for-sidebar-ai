# prompt-builder-for-sidebar-ai

A local browser that builds prompts for sidebar AI from your files.

> [!WARNING]
> **Use at your own risk.** This tool serves files from a directory you
> choose over a local (loopback-only) web server, and helps you copy their
> content into a prompt. It relies entirely on your own judgment about what
> to select and where to paste it:
> - Anything you select and copy can be pasted into a third-party AI product
>   this tool has no relationship with or control over. Consider what you're
>   about to share before you share it -- secrets, credentials, and private
>   data included.
> - File content is untrusted input from this tool's perspective. A file can
>   contain text written to manipulate whatever AI later reads the copied
>   prompt ("prompt injection"). This tool cannot detect or prevent that.
>
> See [THREAT_MODEL.md](THREAT_MODEL.md) for the detailed threat model,
> mitigations, and what's explicitly out of scope.

## Usage

```console
cargo run -- [ROOT]
```

- `ROOT` is an optional directory to serve, or a public GitHub repository URL; it defaults to the current directory (`.`).
- The root must exist and be a directory; otherwise the command prints an error and exits non-zero.
- The server binds to an available port on `127.0.0.1` only (loopback, no external exposure).
- An unguessable session URL (`http://127.0.0.1:<port>/<token>`) is printed and opened in your default browser. Only that exact path responds; every other path returns 404.
- Press Ctrl+C to shut the server down cleanly.

Example:

```console
cargo run -- .
cargo run -- ~/repos/my-project
```

### Serving a GitHub repository URL

`ROOT` also accepts a public GitHub repository URL --
`https://github.com/{owner}/{repo}`, optionally with a `.git` suffix or a
`/tree/{ref}` suffix to check out a specific branch or tag:

```console
cargo run -- https://github.com/owner/repo
cargo run -- https://github.com/owner/repo/tree/some-branch
```

This shallow-clones (`git clone --depth 1`) the repository into a temporary
directory and serves it exactly like any other local root -- `git` must be
installed and on `PATH`. Only public repositories are supported; a private
repository, a nonexistent repository or ref, and a network failure all
surface as the same clone error (git's own message is included). The
temporary clone is removed automatically when the server exits, including
after Ctrl+C.

## Documentation

- [docs/EXPLORER_UI.md](docs/EXPLORER_UI.md) -- the two-pane explorer, the
  embedded app icon (inlined as the favicon and the explorer-pane logo, so no
  extra request and no `/favicon.ico` 404), the English/Japanese language
  toggle, line numbers and stable `@file`/`@dir`/`@lines` references, copy
  actions and output formats, the prompt composer, and selection size
  statistics.
- [docs/API.md](docs/API.md) -- the `/api/root`, `/api/tree`, `/api/file`,
  and `/api/diff` endpoints, what's excluded from the tree, how likely-secret
  files are flagged, and known limitations.
- [THREAT_MODEL.md](THREAT_MODEL.md) -- assets, trust boundaries, threats and
  mitigations, and what's explicitly out of scope.