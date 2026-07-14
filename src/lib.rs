use axum::{
    extract::{Query, State},
    http::{header, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};
use uuid::Uuid;

pub mod diff;
pub mod discovery;
pub mod github_root;

use diff::compute_diff;
use discovery::{discover_tree, is_probably_binary, FileEntry};
use github_root::TempDirGuard;

/// HTML shell template embedded in the binary. `/*__STYLE_PLACEHOLDER__*/`,
/// `//__SCRIPT_PLACEHOLDER__`, and `__ICON_DATA_URI__` are substituted with
/// [`APP_CSS`], [`APP_JS`], and the app icon's `data:` URI (see
/// [`icon_data_uri`]) at first use by [`rendered_index_html`]; the CSS and JS
/// files stay separate on disk (rather than being hand-embedded as Rust
/// string literals) so `assets/app.js` and `assets/style.css` remain plain,
/// lintable, syntax-checkable files with no `format!`-style brace escaping.
const INDEX_TEMPLATE: &str = include_str!("../assets/index.html");
const APP_CSS: &str = include_str!("../assets/style.css");
const APP_JS: &str = include_str!("../assets/app.js");

/// The app icon (favicon + explorer-pane logo), embedded from the single
/// `assets/icon.png` so the page needs no separate icon route and makes no
/// extra network request for it -- see [`icon_data_uri`].
const APP_ICON: &[u8] = include_bytes!("../assets/icon.png");

/// The app icon as a `data:image/png;base64,...` URI, base64-encoded once and
/// reused for every request. Inlining the icon into the single-page HTML (as
/// both the `<link rel="icon">` favicon and the explorer-pane logo) keeps the
/// app request-free: there's no `/favicon.ico` round-trip -- and so no known
/// `/favicon.ico` 404 in the browser console -- and no icon route to add to
/// the token-scoped router.
fn icon_data_uri() -> &'static str {
    static ICON_DATA_URI: OnceLock<String> = OnceLock::new();
    ICON_DATA_URI.get_or_init(|| {
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(APP_ICON)
        )
    })
}

/// Builds the final HTML shell once and reuses it for every request; the
/// template substitution has no per-request inputs (root/token are read by
/// the frontend from `/api/root` and the URL itself, not baked into the
/// HTML). `.replace` substitutes every occurrence, so `__ICON_DATA_URI__` is
/// filled at each place it appears (the favicon links and the logo) in one
/// pass.
fn rendered_index_html() -> &'static str {
    static RENDERED: OnceLock<String> = OnceLock::new();
    RENDERED.get_or_init(|| {
        INDEX_TEMPLATE
            .replace("/*__STYLE_PLACEHOLDER__*/", APP_CSS)
            .replace("//__SCRIPT_PLACEHOLDER__", APP_JS)
            .replace("__ICON_DATA_URI__", icon_data_uri())
    })
}

/// Resolves and validates a local root directory.
///
/// The resolved root becomes the security boundary for the session: later
/// issues must not let the UI navigate above it. Missing paths and paths
/// that are not directories are rejected with a message suitable for
/// display on stderr. For the `ROOT` command-line argument, which may also
/// be a public GitHub repository URL, use
/// [`github_root::resolve_root_arg`] instead -- it calls this function
/// after cloning, if a clone is needed.
pub fn resolve_root(path: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path).map_err(|err| {
        format!(
            "root path '{}' could not be resolved: {err}",
            path.display()
        )
    })?;

    if !canonical.is_dir() {
        return Err(format!(
            "root path '{}' is not a directory",
            canonical.display()
        ));
    }

    Ok(canonical)
}

/// Generates an unguessable session token used to scope the localhost
/// server to a single browser session. Only requests to `/{token}` are
/// served; every other path is rejected.
pub fn generate_session_token() -> String {
    Uuid::new_v4().to_string()
}

/// Shared session state (issue #11): the explorer root became mutable once
/// the UI could replace it without restarting the CLI, so the plain
/// `Arc<PathBuf>` every handler used to receive as `State` is replaced by
/// this struct, wrapped the same way (`Arc<AppState>`).
///
/// - `root` is read by every existing handler (`serve_root`/`serve_tree`/
///   `serve_file`/`serve_diff`) at the start of each request and written by
///   [`serve_open_folder`] once a newly picked folder passes [`resolve_root`]
///   -- so every in-flight and future request immediately sees the new root,
///   and the old root becomes unreachable through every endpoint at once.
/// - `root_guard` holds the [`TempDirGuard`] for a GitHub-URL clone (issue
///   #14), if the session was started that way. It used to be a bare local
///   variable in `main` kept alive only for `Drop`-on-exit timing; now that
///   the root itself can be replaced mid-session, the guard has to live
///   exactly as long as its matching root does, so it moves here and is
///   replaced (dropping the previous guard immediately, not at process exit)
///   in lockstep with `root`.
/// - `dialog_available`/`folder_picker` back [`serve_open_folder`]'s native
///   folder-picker call. In production these are the real environment check
///   and the real (blocking) `rfd` dialog; tests substitute fakes via
///   [`build_router_for_test`], since a headless CI runner has no windowing
///   system to show a real dialog in.
struct AppState {
    root: RwLock<PathBuf>,
    root_guard: RwLock<Option<TempDirGuard>>,
    dialog_available: Box<dyn Fn() -> bool + Send + Sync>,
    folder_picker: Box<dyn Fn() -> Option<PathBuf> + Send + Sync>,
}

impl AppState {
    fn new(root: PathBuf, root_guard: Option<TempDirGuard>) -> Self {
        AppState {
            root: RwLock::new(root),
            root_guard: RwLock::new(root_guard),
            dialog_available: Box::new(native_dialog_available),
            folder_picker: Box::new(|| rfd::FileDialog::new().pick_folder()),
        }
    }

    /// Builds fake-backed state for tests: `root_guard` defaults to `None`
    /// via [`build_router_for_test`] (most tests don't care about it) or is
    /// seeded explicitly via [`build_router_for_test_with_guard`] (needed to
    /// test that switching roots via `serve_open_folder` drops the
    /// *previous* session's guard immediately -- see the `root_guard` doc
    /// comment above).
    fn with_fakes_and_guard(
        root: PathBuf,
        root_guard: Option<TempDirGuard>,
        dialog_available: impl Fn() -> bool + Send + Sync + 'static,
        folder_picker: impl Fn() -> Option<PathBuf> + Send + Sync + 'static,
    ) -> Self {
        AppState {
            root: RwLock::new(root),
            root_guard: RwLock::new(root_guard),
            dialog_available: Box::new(dialog_available),
            folder_picker: Box::new(folder_picker),
        }
    }
}

/// Whether a native folder-picker dialog can plausibly be shown right now.
/// On Linux, `rfd`'s `xdg-portal` backend (the only Linux backend this
/// crate enables -- see the `rfd` dependency in `Cargo.toml` -- since the
/// sibling `wayland` feature only serves `set_parent`-style window
/// parenting that this app never uses, and pulls in a system
/// `wayland-client` pkg-config dependency this app doesn't need) needs a
/// running desktop session; with neither `$DISPLAY` nor `$WAYLAND_DISPLAY`
/// set (a bare SSH
/// session, a headless CI runner, ...) there is no windowing system to show
/// a dialog in at all. `rfd::FileDialog::pick_folder` returns `None` both
/// when the user cancels and when no dialog could be shown, so this is
/// checked up front instead of after the fact -- it's what lets
/// [`serve_open_folder`] report "no dialog available" as a distinct outcome
/// from "cancelled" (issue #11's "degrades clearly" acceptance criterion).
/// macOS and Windows always have a windowing system available to a
/// foreground GUI process, so only the Linux case needs the check.
#[cfg(target_os = "linux")]
fn native_dialog_available() -> bool {
    std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

#[cfg(not(target_os = "linux"))]
fn native_dialog_available() -> bool {
    true
}

/// Builds the Axum router for a single session.
///
/// Only paths under `/{token}` are served; every other path, including the
/// bare root `/`, returns 404 so the server cannot be used without the
/// session token. `root` is the canonicalized directory the session was
/// started with (see [`resolve_root`]); it is the security boundary that
/// `/{token}/api/tree` walks via [`discovery::discover_tree`] and that
/// `/{token}/api/file` validates every request against -- until the user
/// replaces it via `POST /{token}/api/open-folder` (issue #11), after which
/// every handler picks up the new root instead.
pub fn build_router(token: &str, root: PathBuf) -> Router {
    build_router_with_root_guard(token, root, None)
}

/// Like [`build_router`], but also takes ownership of the [`TempDirGuard`]
/// for a GitHub-URL-cloned root (issue #14), if any -- used by `main.rs` so
/// the guard's cleanup-on-drop stays tied to the session's current root
/// instead of a separate process-lifetime local variable (see the
/// [`AppState`] doc comment for why that changed).
pub fn build_router_with_root_guard(
    token: &str,
    root: PathBuf,
    root_guard: Option<TempDirGuard>,
) -> Router {
    let state = Arc::new(AppState::new(root, root_guard));
    build_router_from_state(token, state)
}

/// Test-only hook for exercising `POST /{token}/api/open-folder` end to end
/// (issue #11) without a real native dialog: `tests/server.rs` is a separate
/// integration-test crate, so it cannot see anything gated behind
/// `#[cfg(test)]` in this one, and this project already exposes similar
/// test-supporting `pub` items (e.g. `discovery::MAX_SERVABLE_FILE_SIZE`) for
/// the same reason. `dialog_available`/`folder_picker` replace the real
/// environment check and the real (blocking) `rfd` call, so a headless CI
/// runner -- which has no windowing system to show a dialog in at all -- can
/// still drive the cancel/success/invalid-selection paths deterministically.
pub fn build_router_for_test(
    token: &str,
    root: PathBuf,
    dialog_available: impl Fn() -> bool + Send + Sync + 'static,
    folder_picker: impl Fn() -> Option<PathBuf> + Send + Sync + 'static,
) -> Router {
    build_router_for_test_with_guard(token, root, None, dialog_available, folder_picker)
}

/// Like [`build_router_for_test`], but also seeds `state.root_guard` with a
/// pre-existing [`TempDirGuard`], so a test can start a session that already
/// holds a guard (e.g. standing in for a GitHub-URL clone, issue #14) and
/// then verify that `POST /{token}/api/open-folder` drops -- and so removes
/// from disk -- that *previous* guard immediately on a successful switch,
/// rather than only at process exit (see the [`AppState`] doc comment for
/// why that distinction matters). `build_router_for_test` itself stays
/// guard-less, since every other test using it doesn't need one.
pub fn build_router_for_test_with_guard(
    token: &str,
    root: PathBuf,
    root_guard: Option<TempDirGuard>,
    dialog_available: impl Fn() -> bool + Send + Sync + 'static,
    folder_picker: impl Fn() -> Option<PathBuf> + Send + Sync + 'static,
) -> Router {
    let state = Arc::new(AppState::with_fakes_and_guard(
        root,
        root_guard,
        dialog_available,
        folder_picker,
    ));
    build_router_from_state(token, state)
}

fn build_router_from_state(token: &str, state: Arc<AppState>) -> Router {
    Router::new()
        .route(&format!("/{token}"), get(serve_shell))
        .route(&format!("/{token}/api/root"), get(serve_root))
        .route(&format!("/{token}/api/tree"), get(serve_tree))
        .route(&format!("/{token}/api/file"), get(serve_file))
        .route(&format!("/{token}/api/diff"), get(serve_diff))
        .route(
            &format!("/{token}/api/open-folder"),
            post(serve_open_folder),
        )
        .fallback(not_found)
        .with_state(state)
}

async fn serve_shell() -> impl IntoResponse {
    Html(rendered_index_html())
}

/// Response body for `GET /{token}/api/root`: the selected root's basename
/// and resolved absolute path, so the frontend can present the root as the
/// top-level explorer node without ever needing to navigate above it.
#[derive(Serialize)]
struct RootInfo {
    basename: String,
    #[serde(rename = "absolutePath")]
    absolute_path: String,
}

/// Builds a [`RootInfo`] from a resolved root path -- shared by `serve_root`
/// and [`serve_open_folder`]'s success response so both report the basename/
/// absolute-path pair the same way.
fn root_info(root: &Path) -> RootInfo {
    let basename = root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.display().to_string());
    let absolute_path = root.display().to_string();

    RootInfo {
        basename,
        absolute_path,
    }
}

async fn serve_root(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let root = state.root.read().unwrap().clone();
    Json(root_info(&root))
}

/// Response body for `GET /{token}/api/tree`. `truncated` is `true` when
/// [`discover_tree`] hit [`discovery::MAX_TREE_ENTRIES`] and stopped early
/// (issue #9's resource-limit hardening) -- surfaced explicitly rather than
/// letting a cut-off list look like a complete one, since the frontend (and
/// any bulk-selection/"copy everything" workflow built on top of it) would
/// otherwise have no way to know files are missing.
#[derive(Serialize)]
struct TreeResponse {
    entries: Vec<FileEntry>,
    truncated: bool,
}

async fn serve_tree(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let root = state.root.read().unwrap().clone();
    let (entries, truncated) = discover_tree(&root);
    Json(TreeResponse { entries, truncated })
}

/// Query parameters for `GET /{token}/api/file`.
#[derive(Deserialize)]
struct FileQuery {
    path: Option<String>,
}

/// Serves the plain-text content of a single file beneath the selected
/// root.
///
/// This is the most security-sensitive endpoint in the app (see the
/// `discovery` module docs for the broader threat model this project treats
/// as a first-class concern: a path-traversal bug here is exactly the kind
/// of bug this tool exists to avoid). Rather than joining the untrusted
/// `path` query value onto the root in one shot and canonicalizing the
/// result (which would let a request "probe" whether something exists
/// outside the root, and would not notice a symlink that happens to resolve
/// back inside the root), the request path is validated one path component
/// at a time (steps 1-3 below are implemented by
/// [`discovery::resolve_regular_file`], shared with the Git-diff endpoint's
/// untracked-file handling in `src/diff.rs` so both enforce identical rules):
///
/// 1. Every component of the untrusted `path` query value must be
///    [`Component::Normal`]. A `..` (`ParentDir`), a leading `/`
///    (`RootDir`/`Prefix`), or a `.` (`CurDir`) component is rejected with
///    404 immediately, before anything ever touches the filesystem. This is
///    what makes the traversal case symmetric with the
///    doesn't-exist case: whether `../secret.txt` exists outside the root or
///    not, the request is rejected at the parsing stage, so the response
///    can never be used as an oracle for what exists outside the root.
/// 2. Starting from the canonicalized root, each `Normal` component is
///    pushed onto the path one at a time, and
///    [`std::fs::symlink_metadata`] (which, unlike [`std::fs::metadata`],
///    does not follow a symlink) is checked at every step. If any
///    intermediate component -- or the final one -- is a symlink, or
///    doesn't exist, the request is rejected with 404. This makes
///    `/api/file` refuse symlinks under exactly the same rule
///    `discovery::discover_tree` already uses for `/api/tree` (symlinks are
///    never followed, never served), instead of only checking where a fully
///    resolved symlink chain ends up.
/// 3. Once every component has been validated, the resulting path must be a
///    regular file (not missing, not a directory, not a FIFO/socket/device)
///    before it is ever opened, the same discipline `discover_tree` uses and
///    for the same reason: opening a FIFO with no writer can hang forever.
/// 4. Reusing [`discovery::is_probably_binary`] (the exact same NUL-sniffing
///    heuristic `/{token}/api/tree` uses to exclude binaries) to refuse
///    binary files instead of dumping raw bytes into the page.
///
/// A missing/empty `path` query returns 400. Escaping the root, passing
/// through a symlink at any point, or not existing all return 404 --
/// deliberately merged into one status, so this endpoint can never be used
/// to distinguish "outside the root and exists" from "outside the root and
/// doesn't exist" (this endpoint never returns 403; there is no longer a
/// response that would tell a caller "something is there, you're just not
/// allowed to see it"). A directory path also returns 404. A file larger
/// than [`discovery::MAX_SERVABLE_FILE_SIZE`] returns 400 (issue #9's
/// resource-limit hardening: an unbounded read of an arbitrarily large file
/// would otherwise be able to exhaust memory/time on a single request). A
/// binary file returns 400. A file that exists, is a regular file, passed
/// the size check, and passed every check above but still can't be read
/// (e.g. a permission error) returns 500, distinct from the binary-file/
/// too-large 400s so callers aren't told a permission error is a
/// binary-format or size problem. File bytes that are not valid UTF-8 are
/// rejected with 400 rather than lossily replacing the invalid bytes, so
/// callers can tell the difference between "this is text" and "this looked
/// like text to the NUL-sniff heuristic but isn't valid UTF-8".
async fn serve_file(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FileQuery>,
) -> Response {
    let root = state.root.read().unwrap().clone();
    let requested_path = match query.path.as_deref() {
        Some(path) if !path.is_empty() => path,
        _ => return (StatusCode::BAD_REQUEST, "missing 'path' query parameter").into_response(),
    };

    // `root` is already canonicalized by `resolve_root` in the normal
    // (main.rs) path, but re-canonicalizing here is cheap and makes this
    // function correct regardless of what the caller passed as `root`
    // (e.g. a test harness that skips `resolve_root`).
    let canonical_root = match std::fs::canonicalize(root.as_path()) {
        Ok(canonical_root) => canonical_root,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to resolve the root directory",
            )
                .into_response()
        }
    };

    // Validated one `Normal` path component at a time -- rejecting anything
    // that would escape the root, pass through a symlink, or exceed the
    // size cap -- by `discovery::resolve_regular_file`. See the function doc
    // comment above for why this replaces the previous "join, canonicalize,
    // then `starts_with`" approach; see `resolve_regular_file`'s own doc
    // comment for the exact rules (also shared by the Git-diff module's
    // untracked-file handling, so both places enforce the identical policy).
    let candidate = match discovery::resolve_regular_file(&canonical_root, requested_path) {
        Ok(candidate) => candidate,
        Err(discovery::ResolveError::Invalid) => {
            return (StatusCode::NOT_FOUND, "file not found").into_response()
        }
        Err(discovery::ResolveError::TooLarge) => {
            return (StatusCode::BAD_REQUEST, "file is too large to serve").into_response()
        }
    };

    match is_probably_binary(&candidate) {
        Ok(true) => {
            return (StatusCode::BAD_REQUEST, "binary files are not supported").into_response()
        }
        Ok(false) => {}
        Err(_) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, "could not read file").into_response()
        }
    }

    let bytes = match std::fs::read(&candidate) {
        Ok(bytes) => bytes,
        Err(_) => return (StatusCode::NOT_FOUND, "file not found").into_response(),
    };

    match String::from_utf8(bytes) {
        Ok(text) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            text,
        )
            .into_response(),
        Err(_) => (StatusCode::BAD_REQUEST, "file is not valid UTF-8").into_response(),
    }
}

/// Response body for `GET /{token}/api/diff`: see [`diff::compute_diff`] for
/// what `isGitRepo`/`diff` mean and how each degrades gracefully (a
/// non-Git root, a repository with no commits yet, a clean working tree with
/// nothing to show).
#[derive(Serialize)]
struct DiffResponse {
    #[serde(rename = "isGitRepo")]
    is_git_repo: bool,
    diff: String,
}

async fn serve_diff(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let root = state.root.read().unwrap().clone();
    let result = compute_diff(&root);
    Json(DiffResponse {
        is_git_repo: result.is_git_repo,
        diff: result.diff,
    })
}

/// Response body for `POST /{token}/api/open-folder` (issue #11). Every
/// outcome is reported through this struct rather than a bare HTTP status,
/// since a native dialog's "nothing selected" can mean either "the user
/// cancelled" (not an error -- the previous root stays active) or "no dialog
/// could be shown at all" (a distinct, clearly-surfaced degradation, e.g. a
/// headless Linux session with no `$DISPLAY`/`$WAYLAND_DISPLAY`) --
/// `rfd::FileDialog::pick_folder` itself returns `None` for both, so
/// [`serve_open_folder`] tells them apart with `state.dialog_available`
/// *before* ever calling the picker. `status` is one of:
///
/// - `"unavailable"` (HTTP 501): no dialog could be shown; `available` is
///   `false` and every other field is absent.
/// - `"cancelled"` (HTTP 200): the dialog was shown but the user picked
///   nothing; the root is untouched.
/// - `"error"` (HTTP 400): the user picked something that failed
///   [`resolve_root`] (e.g. removed between the pick and validation, or not
///   a directory); `message` explains why. The root is untouched.
/// - `"ok"` (HTTP 200): the user picked a valid folder; `basename`/
///   `absolutePath` describe the new root, which has already been swapped
///   in (see [`serve_open_folder`]).
#[derive(Serialize)]
struct OpenFolderResponse {
    available: bool,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    basename: Option<String>,
    #[serde(rename = "absolutePath", skip_serializing_if = "Option::is_none")]
    absolute_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl OpenFolderResponse {
    fn unavailable() -> Self {
        OpenFolderResponse {
            available: false,
            status: "unavailable",
            basename: None,
            absolute_path: None,
            message: None,
        }
    }

    fn cancelled() -> Self {
        OpenFolderResponse {
            available: true,
            status: "cancelled",
            basename: None,
            absolute_path: None,
            message: None,
        }
    }

    fn ok(info: RootInfo) -> Self {
        OpenFolderResponse {
            available: true,
            status: "ok",
            basename: Some(info.basename),
            absolute_path: Some(info.absolute_path),
            message: None,
        }
    }

    fn error(message: String) -> Self {
        OpenFolderResponse {
            available: true,
            status: "error",
            basename: None,
            absolute_path: None,
            message: Some(message),
        }
    }
}

/// Handles `POST /{token}/api/open-folder` (issue #11): the UI's "Open
/// another folder" action, letting the explorer root be replaced without
/// restarting the CLI.
///
/// `state.dialog_available` is checked first (see its doc comment for why);
/// if it returns `false`, this returns 501 immediately without ever touching
/// `state.folder_picker`. Otherwise `state.folder_picker` -- the real,
/// blocking `rfd::FileDialog::pick_folder` in production, a fake in tests --
/// runs inside [`tokio::task::spawn_blocking`], since it's a synchronous call
/// that would otherwise block this request's async worker thread for as long
/// as the dialog is open.
///
/// A picked folder is re-validated with the exact same [`resolve_root`] every
/// other root goes through -- nothing about how a folder was chosen makes it
/// exempt from the same "must exist, must be a directory, symlinks resolved"
/// rules. Only once that succeeds are `state.root` and `state.root_guard`
/// swapped (dropping any previous GitHub-clone guard immediately, rather than
/// leaving it to accumulate until process exit -- see the [`AppState`] doc
/// comment), so a cancelled dialog or a failed re-validation both leave the
/// current root completely untouched.
async fn serve_open_folder(State(state): State<Arc<AppState>>) -> Response {
    if !(state.dialog_available)() {
        return (
            StatusCode::NOT_IMPLEMENTED,
            Json(OpenFolderResponse::unavailable()),
        )
            .into_response();
    }

    let picker_state = Arc::clone(&state);
    let picked = match tokio::task::spawn_blocking(move || (picker_state.folder_picker)()).await {
        Ok(picked) => picked,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(OpenFolderResponse::error(
                    "the folder-picker task panicked".to_string(),
                )),
            )
                .into_response()
        }
    };

    let Some(picked_path) = picked else {
        return (StatusCode::OK, Json(OpenFolderResponse::cancelled())).into_response();
    };

    let new_root = match resolve_root(&picked_path) {
        Ok(new_root) => new_root,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(OpenFolderResponse::error(err)),
            )
                .into_response()
        }
    };

    let info = root_info(&new_root);

    *state.root.write().unwrap() = new_root;
    *state.root_guard.write().unwrap() = None;

    (StatusCode::OK, Json(OpenFolderResponse::ok(info))).into_response()
}

async fn not_found() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, "not found")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    // `APP_ICON` is `include_bytes!`, so a newer clippy can prove its length
    // is a fixed, nonzero compile-time constant and flags this assertion as
    // always-true noise (`const_is_empty`). Pre-existing lint drift, unrelated
    // to issue #11 -- allowed rather than deleted, since the assertion still
    // documents and locks in the real invariant (a corrupted/emptied
    // `assets/icon.png` should fail this test, not just the PNG-magic-bytes
    // check below).
    #[allow(clippy::const_is_empty)]
    fn app_icon_is_a_nonempty_png() {
        assert!(
            !APP_ICON.is_empty(),
            "the embedded app icon should not be empty"
        );
        assert!(
            APP_ICON.starts_with(b"\x89PNG"),
            "the embedded app icon should start with the PNG magic bytes"
        );
    }

    #[test]
    fn icon_data_uri_is_a_base64_png_data_uri() {
        let uri = icon_data_uri();
        assert!(
            uri.starts_with("data:image/png;base64,"),
            "the icon should be exposed as a base64 PNG data URI: {uri}"
        );
        assert!(
            uri.len() > "data:image/png;base64,".len(),
            "the data URI should carry the encoded icon payload"
        );
    }

    #[test]
    fn rendered_html_inlines_the_icon_and_leaves_no_placeholder() {
        let html = rendered_index_html();
        assert!(
            html.contains("data:image/png;base64,"),
            "the rendered HTML should inline the icon as a data URI"
        );
        assert!(
            !html.contains("__ICON_DATA_URI__"),
            "every icon placeholder should be substituted, none left behind"
        );
    }

    #[test]
    fn rendered_html_search_icon_is_decorative_and_label_survives() {
        // issue #15 follow-up: the search box grew a decorative funnel <svg>.
        // It must stay aria-hidden (so screen readers don't double-announce
        // the filter box) and must not have displaced the existing
        // <label for="search-input"> that actually names the field.
        let html = rendered_index_html();
        assert!(
            html.contains(r#"<svg class="search-icon" viewBox="0 0 16 16" aria-hidden="true""#),
            "the search icon should be a decorative, aria-hidden svg"
        );
        assert!(
            html.contains(
                r#"<label for="search-input" class="visually-hidden" data-i18n="search.label""#
            ),
            "the accessible label for the search input should still be present"
        );
    }

    #[test]
    fn rendered_html_app_name_has_no_data_i18n_attribute() {
        // issue #35: the app name is a proper noun/product name, identical in
        // every locale, so unlike translatable static chrome it must never be
        // wired into the data-i18n find-and-replace pipeline. Scan just the
        // app-name span's own opening tag for a data-i18n attribute (rather
        // than the whole page, which legitimately has many) so this doesn't
        // pass or fail for the wrong reason.
        let html = rendered_index_html();
        let tag_start = html
            .find(r#"<span class="app-name""#)
            .expect("the app-name element should exist");
        let tag_end = html[tag_start..]
            .find('>')
            .map(|i| tag_start + i)
            .expect("the app-name opening tag should close");
        let opening_tag = &html[tag_start..tag_end];
        assert!(
            !opening_tag.contains("data-i18n"),
            "the app-name element should not carry a data-i18n attribute: {opening_tag}"
        );
    }

    #[test]
    fn rendered_html_app_name_title_matches_the_logos_alt_and_title() {
        // issue #35: the app name became a permanently visible `.app-name`
        // text node, but the `<img class="app-logo">`'s alt/title are kept
        // too, as a fallback if the visible text is ever ellipsis-clipped
        // down to nothing. All of them should still agree on the same name.
        let html = rendered_index_html();
        assert!(
            html.contains(r#"alt="prompt-builder-for-sidebar-ai""#),
            "the logo's alt text should still name the app"
        );
        assert!(
            html.contains(
                r#"<span class="app-name" title="prompt-builder-for-sidebar-ai">prompt-builder-for-sidebar-ai</span>"#
            ),
            "the app-name span should carry a matching title attribute and visible text"
        );
    }

    #[test]
    fn rendered_html_security_notice_collapsed_button_starts_hidden() {
        // issue #36: dismissing the security notice now collapses it into
        // this one strip (the single reopen affordance) instead of a
        // separate button elsewhere, and it must start hidden -- the full
        // notice is what's shown before any dismissal.
        let html = rendered_index_html();
        let id_pos = html
            .find(r#"id="security-notice-collapsed""#)
            .expect("the security-notice-collapsed button should exist");
        let button_start = html[..id_pos]
            .rfind("<button")
            .expect("should find the enclosing <button tag");
        let tag_end = html[button_start..]
            .find('>')
            .map(|i| button_start + i)
            .expect("the button's opening tag should close");
        let opening_tag = &html[button_start..tag_end];
        assert!(
            opening_tag.contains("hidden"),
            "the collapsed security-notice button should start hidden: {opening_tag}"
        );
    }

    #[test]
    fn rendered_html_has_no_leftover_security_reopen_button() {
        // issue #36 removed the old issue-#28-era "🛡 Safety" `#security-reopen`
        // button in favor of the single `#security-notice-collapsed` strip;
        // this pins down that removal so it can't silently come back.
        let html = rendered_index_html();
        assert!(
            !html.contains(r#"id="security-reopen""#),
            "the old #security-reopen button should have been fully removed"
        );
    }

    #[test]
    fn resolve_root_accepts_an_existing_directory() {
        let resolved = resolve_root(Path::new(".")).expect("current directory should resolve");
        assert!(resolved.is_absolute());
        assert!(resolved.is_dir());
    }

    #[test]
    fn resolve_root_rejects_a_missing_path() {
        let err = resolve_root(Path::new("./this-path-should-not-exist-abc123"))
            .expect_err("missing path should be rejected");
        assert!(err.contains("could not be resolved"));
    }

    #[test]
    fn resolve_root_rejects_a_file() {
        let err = resolve_root(Path::new("./Cargo.toml")).expect_err("a file is not a valid root");
        assert!(err.contains("is not a directory"));
    }

    #[test]
    fn resolve_root_rejects_an_empty_path() {
        let err = resolve_root(Path::new("")).expect_err("an empty path should be rejected");
        assert!(err.contains("could not be resolved"));
    }

    #[test]
    fn resolve_root_accepts_a_non_ascii_directory_name() {
        let scratch = ScratchDir::new("non-ascii");
        let target = scratch.path().join("日本語ディレクトリ");
        std::fs::create_dir(&target).expect("should create the non-ascii directory");

        let resolved = resolve_root(&target).expect("a non-ascii directory should resolve");
        assert!(resolved.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_root_resolves_a_symlink_to_a_directory() {
        let scratch = ScratchDir::new("symlink-dir");
        let real_dir = scratch.path().join("real");
        std::fs::create_dir(&real_dir).expect("should create the real directory");
        let link = scratch.path().join("link-to-real");
        std::os::unix::fs::symlink(&real_dir, &link).expect("should create the symlink");

        let resolved = resolve_root(&link).expect("a symlink to a directory should resolve");
        assert_eq!(
            resolved,
            real_dir
                .canonicalize()
                .expect("real dir should canonicalize")
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_root_rejects_a_symlink_to_a_file() {
        let scratch = ScratchDir::new("symlink-file");
        let real_file = scratch.path().join("real.txt");
        std::fs::write(&real_file, b"contents").expect("should create the real file");
        let link = scratch.path().join("link-to-file");
        std::os::unix::fs::symlink(&real_file, &link).expect("should create the symlink");

        let err = resolve_root(&link).expect_err("a symlink to a file should be rejected");
        assert!(err.contains("is not a directory"));
    }

    #[cfg(unix)]
    #[test]
    fn resolve_root_rejects_a_dangling_symlink() {
        let scratch = ScratchDir::new("dangling-symlink");
        let missing_target = scratch.path().join("this-target-should-not-exist");
        let link = scratch.path().join("link-to-missing");
        std::os::unix::fs::symlink(&missing_target, &link).expect("should create the symlink");

        let err = resolve_root(&link).expect_err("a dangling symlink should be rejected");
        assert!(err.contains("could not be resolved"));
    }

    #[test]
    fn generate_session_token_is_unique_each_call() {
        let a = generate_session_token();
        let b = generate_session_token();
        assert_ne!(a, b);
        assert!(!a.is_empty());
    }

    #[test]
    fn generate_session_token_matches_uuid_v4_format() {
        let token = generate_session_token();

        assert_eq!(
            token.len(),
            36,
            "token should be the canonical 36-char UUID length: {token}"
        );

        let groups: Vec<&str> = token.split('-').collect();
        assert_eq!(
            groups.iter().map(|g| g.len()).collect::<Vec<_>>(),
            vec![8, 4, 4, 4, 12],
            "token should have the 8-4-4-4-12 UUID grouping: {token}"
        );
        assert!(
            groups.iter().all(|g| g
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())),
            "every group should be lowercase hex digits: {token}"
        );
        assert_eq!(
            groups[2].chars().next(),
            Some('4'),
            "UUID version nibble should be 4 (v4): {token}"
        );
        let variant_nibble = groups[3].chars().next().expect("group should be non-empty");
        assert!(
            matches!(variant_nibble, '8' | '9' | 'a' | 'b'),
            "UUID variant nibble should be one of 8/9/a/b (RFC 4122): {token}"
        );
    }

    /// Serializes every test that mutates `$DISPLAY`/`$WAYLAND_DISPLAY`
    /// (currently just [`native_dialog_available_reflects_display_env_vars`]
    /// below), since Rust runs tests in one process by default and these are
    /// process-wide environment variables -- without this lock, two such
    /// tests running concurrently could each observe the other's in-progress
    /// mutation. Kept even though there is only one such test today, so a
    /// future second one is safe by construction rather than by remembering
    /// to add this.
    #[cfg(target_os = "linux")]
    static DISPLAY_ENV_VAR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Snapshots one environment variable's current value on construction
    /// and restores it (set or removed, whichever it was) on drop -- so a
    /// test can freely overwrite `$DISPLAY`/`$WAYLAND_DISPLAY` and still
    /// leave the process environment exactly as it found it afterward, even
    /// if an assertion in between panics (the restoring `Drop` still runs
    /// during unwinding).
    #[cfg(target_os = "linux")]
    struct EnvVarRestorer {
        name: &'static str,
        original: Option<std::ffi::OsString>,
    }

    #[cfg(target_os = "linux")]
    impl EnvVarRestorer {
        fn capture(name: &'static str) -> Self {
            EnvVarRestorer {
                name,
                original: std::env::var_os(name),
            }
        }
    }

    #[cfg(target_os = "linux")]
    impl Drop for EnvVarRestorer {
        fn drop(&mut self) {
            // SAFETY: `DISPLAY_ENV_VAR_LOCK` is held for the entire lifetime
            // of every `EnvVarRestorer` (constructed only from inside the
            // lock's guarded section below), so no other thread can be
            // reading/writing the environment concurrently with this call.
            unsafe {
                match &self.original {
                    Some(value) => std::env::set_var(self.name, value),
                    None => std::env::remove_var(self.name),
                }
            }
        }
    }

    /// Issue #11 should-fix: every existing test reaches `AppState` through
    /// `with_fakes_and_guard`/`build_router_for_test`, which always inject a fake
    /// `dialog_available` closure -- so the real, production
    /// `native_dialog_available` (the `$DISPLAY`/`$WAYLAND_DISPLAY` check
    /// used on Linux) was never exercised by any test at all; flipping its
    /// `||` to `&&` still left the whole suite green. This test drives it
    /// directly instead, covering all four combinations of the two
    /// variables being set/unset.
    #[cfg(target_os = "linux")]
    #[test]
    fn native_dialog_available_reflects_display_env_vars() {
        let _lock = DISPLAY_ENV_VAR_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _display_restorer = EnvVarRestorer::capture("DISPLAY");
        let _wayland_restorer = EnvVarRestorer::capture("WAYLAND_DISPLAY");

        // SAFETY: see the `Drop for EnvVarRestorer` comment above -- this
        // whole function runs under `DISPLAY_ENV_VAR_LOCK`.
        unsafe {
            std::env::remove_var("DISPLAY");
            std::env::remove_var("WAYLAND_DISPLAY");
        }
        assert!(
            !native_dialog_available(),
            "neither $DISPLAY nor $WAYLAND_DISPLAY set should mean no dialog is available"
        );

        unsafe {
            std::env::set_var("DISPLAY", ":0");
            std::env::remove_var("WAYLAND_DISPLAY");
        }
        assert!(
            native_dialog_available(),
            "$DISPLAY alone set should mean a dialog is available"
        );

        unsafe {
            std::env::remove_var("DISPLAY");
            std::env::set_var("WAYLAND_DISPLAY", "wayland-0");
        }
        assert!(
            native_dialog_available(),
            "$WAYLAND_DISPLAY alone set should mean a dialog is available"
        );

        unsafe {
            std::env::set_var("DISPLAY", ":0");
            std::env::set_var("WAYLAND_DISPLAY", "wayland-0");
        }
        assert!(
            native_dialog_available(),
            "both $DISPLAY and $WAYLAND_DISPLAY set should mean a dialog is available"
        );
    }

    /// A directory under the OS temp dir that is removed on drop, so tests
    /// can exercise `resolve_root`'s filesystem-touching branches (non-ASCII
    /// names, symlinks) without adding a `tempfile` dependency.
    struct ScratchDir(PathBuf);

    impl ScratchDir {
        fn new(name_hint: &str) -> Self {
            let unique = format!(
                "prompt-builder-resolve-root-{name_hint}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("system clock should be after the epoch")
                    .as_nanos()
            );
            let path = std::env::temp_dir().join(unique);
            std::fs::create_dir_all(&path).expect("should create a scratch directory");
            ScratchDir(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
