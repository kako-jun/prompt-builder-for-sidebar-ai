# Threat model

This document describes what `prompt-builder-for-sidebar-ai` protects against,
what it deliberately does not, and why -- written for issue #9's "focused
threat-model document" acceptance criterion. See README.md for the
user-facing summary and disclaimer; this is the more detailed companion.

## What this tool is

A local CLI that serves a chosen directory's files over a loopback-only HTTP
server, renders them in a browser tab, and helps the user assemble a prompt
(optionally including that file content) to paste into a separate, unrelated
AI product (a browser-sidebar assistant, a chat UI, an agent). It never talks
to an AI API itself and never writes to the served directory.

## Assets

- **The served files' contents.** Whatever is inside the selected root:
  source code, documentation, and potentially secrets, credentials, or
  private data the user didn't intend to share.
- **The local filesystem outside the selected root.** Must stay unreachable
  through this tool regardless of what's inside the root (symlinks, `..`
  segments, absolute paths in a query value, etc.).
- **The user's clipboard / whatever they eventually paste into a
  third-party AI.** The last step in this tool's own control is "put text on
  the clipboard"; what happens after that is the user's judgment call, not
  something this tool can enforce.

## Trust boundaries

1. **The browser tab <-> the local server.** The browser is trusted no more
   than any other HTTP client that can reach `127.0.0.1`: every request is
   validated as if it might be hostile, not just "this is our own frontend
   so it must be fine." This matters because the session URL, while
   unguessable, could leak (browser history, a screen share, a copy-pasted
   URL) or another local process/user on the same machine could simply guess
   at connecting to the loopback port.
2. **The selected root <-> the rest of the filesystem.** The root is the
   explicit boundary the user drew by choosing what directory to run this
   tool against. Nothing outside it should ever become reachable through any
   endpoint, no matter how the request is shaped. Issue #11 lets the user
   *replace* this boundary at runtime (`POST /{token}/api/open-folder`), but
   only by drawing a new one the same explicit way: through a native
   folder-selection dialog the local backend shows (never handing the
   browser itself arbitrary filesystem access), re-validated with the exact
   same `resolve_root` every `ROOT` CLI argument goes through. Once swapped,
   the previous root is fully retired, not merely superseded -- every
   endpoint reads the current root from shared state on each request, so
   there is no stale code path left that could still serve the old one.
3. **File content <-> the rendered page's DOM.** File content is untrusted
   input from the tool's own perspective (a file could contain anything,
   including text authored specifically to look like markup or script) and
   must never be interpreted as HTML/script by the browser.
4. **File content <-> the AI the user eventually pastes it into.** Once
   copied, file content leaves this tool's control entirely. A file's
   content could contain text written to manipulate whatever AI reads it
   next ("prompt injection") -- this tool cannot detect or prevent that, only
   disclose that the risk exists.

## Threats considered, and the mitigation

| Threat | Mitigation |
| --- | --- |
| Path traversal (`../../etc/passwd`, an absolute path, a `.`/`..` segment anywhere in a requested path) reads a file outside the selected root. | Every untrusted path (`/api/file`'s query value, an untracked Git path from `git status`) is validated one path component at a time via `discovery::resolve_regular_file`: any component that isn't a plain name is rejected before the filesystem is ever touched. See `src/discovery.rs`. |
| A symlink inside the root (or the root itself) is used to read/list something outside it. | Symlinks are never followed, anywhere: `discover_tree` walks with `follow_links(false)` and separately re-checks every entry; `resolve_regular_file` checks `symlink_metadata` (which does not follow the link) at every path component, not just the final one. |
| A crafted request distinguishes "outside the root and exists" from "outside the root and doesn't exist" (an oracle for probing the filesystem). | `/api/file` collapses every rejection reason (escapes the root, passes through a symlink, doesn't exist) into the same 404, and never returns 403 ("something is there, you're just not allowed to see it"). |
| The server is reachable from another machine on the network. | `TcpListener::bind("127.0.0.1:0")` -- loopback only, OS-assigned port, tested (`server_binds_to_a_loopback_address_only`). |
| Another local process/user guesses the session path. | The session path is a UUID v4 (122 bits of randomness) appended after the port; every other path returns 404. This is unguessable in practice but not a substitute for the loopback binding above -- both matter. |
| File content is interpreted as HTML/script by the browser (XSS via a filename or a file's own content). | The frontend never inserts untrusted text via `innerHTML`; every dynamic string (paths, file content, server JSON fields) goes through `textContent`/`Option`-style DOM APIs, which the browser never parses as markup. `/api/file` also serves with `Content-Type: text/plain`, so even direct navigation to the raw endpoint can't be interpreted as HTML. |
| A secret-looking file (`.env`, a private key, ...) is silently included in a prompt without the user noticing. | Flagged (`likely_secret: true`), not hidden -- the user sees a warning badge before choosing to include it. (Deliberately flagged rather than excluded: hiding it outright would be a false sense of security once a name pattern is inevitably missed, and would prevent a user who *does* want to inspect/share it, e.g. a `.env.example` template, from doing so.) |
| A pathological directory (huge file count, an enormous single file) makes a request hang or exhaust memory. | `discover_tree` caps the walk at `MAX_TREE_ENTRIES` *visited* items -- not just how many end up collected, so a tree dominated by filtered-out items (an enormous number of symlinks, or binaries, since checking one means opening and reading it) can't blow through the cap for free; `/api/file` and the Git-diff endpoint both refuse a file over `MAX_SERVABLE_FILE_SIZE` (issue #9). Neither cap is meant to be reached by an ordinary project -- they're backstops, not a feature. A hit cap is surfaced, not silent: `/api/tree` reports `truncated: true` and the explorer UI shows a warning, rather than a cut-off list quietly looking complete; which entries survive is deterministic (name-sorted per directory during the walk) rather than depending on unspecified filesystem enumeration order. |
| A non-regular file (FIFO, device, socket) is opened and blocks the request forever (e.g. a FIFO with no writer). | Never opened at all: both `discover_tree` and `resolve_regular_file` check the file type first and skip/refuse anything that isn't a regular file or directory. |
| Prompt injection: a file's content contains text written to manipulate whatever AI later reads the copied prompt. | **Not preventable by this tool** -- there is no reliable way to distinguish "legitimate file content" from "content crafted to look like an instruction" from outside the AI itself. Disclosed instead: an on-page notice (see `assets/index.html`'s `#security-notice`) and this document. |
| Copied content is sent to a third-party AI provider the user didn't fully consider (privacy). | **The user's judgment, not this tool's to enforce** -- disclosed via the same on-page notice and the README's disclaimer. This tool's own job ends at "put correctly-scoped, unambiguously-delimited text on the clipboard." |
| `ROOT` given as a GitHub URL (issue #14) clones from an unexpected location, or the clone itself is unbounded. | The clone URL is always reconstructed as `https://github.com/{owner}/{repo}.git` from the parsed owner/repo, never the raw input string, so the CLI argument can't inject a different protocol or host at the URL-parsing level. Once on disk, the clone is validated identically to any other local root -- no new logic needed there. **Not mitigated**: `git clone --depth 1` bounds history but not working-tree size, and the clone has no timeout; see "Explicitly out of scope" below. |
| "Open another folder" (issue #11) is used to smuggle in a path outside what the user meant to browse, or the previous root stays reachable after the switch. | The browser never picks the path itself -- `POST /{token}/api/open-folder` only ever triggers a *native, backend-shown* dialog (`rfd::FileDialog::pick_folder`), so the request body can't carry an arbitrary path for the server to trust. Whatever the dialog returns still goes through the identical `resolve_root` validation as the `ROOT` CLI argument (must exist, must be a directory, symlinks resolved). Every handler reads the root from shared state fresh on each request rather than capturing it once at startup, so the moment the swap happens the previous root is not just "also still there" -- it is completely unreachable through every endpoint, immediately, for every subsequent request. |

Issue #9 originally shipped `#security-notice` with no dismiss control and no
"once per session" concession, on the theory that a security disclosure
shouldn't be something a user mutes once and never sees again. Issue #28
reversed that: real usage showed a notice pinned for the whole session
becomes pure noise after the first read, and the original wording read as
"this app is dangerous" rather than naming the actual risk (untrusted file
content; an external, uncontrolled AI on the receiving end of a paste). The
notice now shows once (persisted via `localStorage`, guarded so a
private-browsing/non-browser context degrades to "always show" rather than
throwing), is dismissible with a close button, and can be re-opened on demand
-- the disclosure itself was never removed, only the forced-every-load
display. Issue #36 changed *where* it reopens from: dismissing no longer
hides the notice outright, it collapses the same top-of-page slot into a thin
"🛡 Safety notice" strip that expands the full notice again on click, rather
than the earlier design's separate "🛡 Safety" button in the brand row.

## Explicitly out of scope

- **Authentication / authorization beyond the unguessable session path.**
  This is a single-user local developer tool, not a multi-tenant service.
- **Protecting against a compromised machine.** If an attacker already has
  arbitrary code execution on the machine running this tool, the loopback
  server is not a meaningful additional boundary -- that attacker can already
  read the same files directly.
- **Detecting or blocking prompt injection.** See the table above; this is a
  disclosure, not a defense.
- **Validating what the user chooses to paste where.** Once text is on the
  clipboard, this tool has no further visibility or control.
- **Exhaustive secret detection.** The `likely_secret` heuristic is a small,
  hand-picked list of common patterns (see [docs/API.md](docs/API.md)'s
  "Known limitations"), not a secret-scanning product. A project's own
  `.gitignore` remains the primary defense against exposing files that
  shouldn't be browsed at all.
- **Bounding a GitHub-URL clone's size or duration.** `ROOT` given as a
  `https://github.com/...` URL (issue #14) is shallow-cloned with no disk
  space cap and no timeout -- a very large public repository or a stalled
  network connection can consume significant disk space or block startup
  indefinitely. Only clone a repository whose size you already trust, the
  same "use at your own risk" posture as everything else this tool does with
  a path or URL you give it. Separately, resolving `github.com` itself is
  left entirely to the OS/git configuration; a machine whose DNS or git
  config has already been tampered with to redirect that hostname is a
  compromised-machine scenario, already out of scope above.

## Where the tests live

- `src/discovery.rs` -- traversal/symlink defenses for `/api/tree`'s walk,
  the size/entry-count caps, secret-file flagging.
- `src/lib.rs` -- traversal/symlink defenses for `/api/file` (via the shared
  `resolve_regular_file`), loopback-only binding, session-path handling
  (wrong/truncated/extra-segment token, wrong method), the file-size cap.
- `src/diff.rs` -- the same defenses applied to the Git-diff endpoint's
  untracked-file handling.
- `src/github_root.rs` -- GitHub URL parsing (rejects unsupported shapes
  rather than guessing) and the clone-URL is always reconstructed from the
  parsed owner/repo, never the raw input.
- `tests/server.rs` -- the same, exercised as real HTTP requests against a
  running server rather than unit-level function calls.
- `assets/app.test.js` -- output-escaping coverage for the four copy formats
  (`escapeXmlAttribute`/`escapeXmlText`, Markdown fence escalation).

These run in CI (`.github/workflows/ci.yml`) on every push and pull request.
