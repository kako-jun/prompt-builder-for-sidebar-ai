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