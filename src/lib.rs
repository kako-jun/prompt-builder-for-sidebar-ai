use axum::{
    extract::{Query, State},
    http::{header, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};
use uuid::Uuid;

pub mod discovery;

use discovery::{discover_tree, is_probably_binary, FileEntry};

/// HTML shell template embedded in the binary. `/*__STYLE_PLACEHOLDER__*/`
/// and `//__SCRIPT_PLACEHOLDER__` are substituted with [`APP_CSS`] and
/// [`APP_JS`] at first use by [`rendered_index_html`]; the three files stay
/// separate on disk (rather than being hand-embedded as Rust string
/// literals) so `assets/app.js` and `assets/style.css` remain plain,
/// lintable, syntax-checkable files with no `format!`-style brace escaping.
const INDEX_TEMPLATE: &str = include_str!("../assets/index.html");
const APP_CSS: &str = include_str!("../assets/style.css");
const APP_JS: &str = include_str!("../assets/app.js");

/// Builds the final HTML shell once and reuses it for every request; the
/// template substitution has no per-request inputs (root/token are read by
/// the frontend from `/api/root` and the URL itself, not baked into the
/// HTML).
fn rendered_index_html() -> &'static str {
    static RENDERED: OnceLock<String> = OnceLock::new();
    RENDERED.get_or_init(|| {
        INDEX_TEMPLATE
            .replace("/*__STYLE_PLACEHOLDER__*/", APP_CSS)
            .replace("//__SCRIPT_PLACEHOLDER__", APP_JS)
    })
}

/// Resolves and validates the root directory passed on the command line.
///
/// The resolved root becomes the security boundary for the session: later
/// issues must not let the UI navigate above it. Missing paths and paths
/// that are not directories are rejected with a message suitable for
/// display on stderr.
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

/// Builds the Axum router for a single session.
///
/// Only paths under `/{token}` are served; every other path, including the
/// bare root `/`, returns 404 so the server cannot be used without the
/// session token. `root` is the canonicalized directory the session was
/// started with (see [`resolve_root`]); it is the security boundary that
/// `/{token}/api/tree` walks via [`discovery::discover_tree`] and that
/// `/{token}/api/file` validates every request against.
pub fn build_router(token: &str, root: PathBuf) -> Router {
    let state = Arc::new(root);

    Router::new()
        .route(&format!("/{token}"), get(serve_shell))
        .route(&format!("/{token}/api/root"), get(serve_root))
        .route(&format!("/{token}/api/tree"), get(serve_tree))
        .route(&format!("/{token}/api/file"), get(serve_file))
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

async fn serve_root(State(root): State<Arc<PathBuf>>) -> impl IntoResponse {
    let basename = root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.display().to_string());
    let absolute_path = root.display().to_string();

    Json(RootInfo {
        basename,
        absolute_path,
    })
}

async fn serve_tree(State(root): State<Arc<PathBuf>>) -> impl IntoResponse {
    let entries: Vec<FileEntry> = discover_tree(&root);
    Json(entries)
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
/// at a time:
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
/// allowed to see it"). A directory path also returns 404. A binary file
/// returns 400. A file that exists, is a regular file, and passed every
/// check above but still can't be read (e.g. a permission error) returns 500,
/// distinct from the binary-file 400 so callers aren't told a permission
/// error is a binary-format problem. File bytes that are not valid UTF-8 are
/// rejected with 400 rather than lossily replacing the invalid bytes, so
/// callers can tell the difference between "this is text" and "this looked
/// like text to the NUL-sniff heuristic but isn't valid UTF-8".
async fn serve_file(State(root): State<Arc<PathBuf>>, Query(query): Query<FileQuery>) -> Response {
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

    // Build the candidate path one `Normal` component at a time, checking at
    // every step that the component neither escapes the root (by rejecting
    // anything other than `Normal` outright, before touching the
    // filesystem) nor passes through a symlink. See the function doc comment
    // above for why this replaces the previous "join, canonicalize, then
    // `starts_with`" approach.
    let mut candidate = canonical_root.clone();
    for component in Path::new(requested_path).components() {
        let Component::Normal(part) = component else {
            return (StatusCode::NOT_FOUND, "file not found").into_response();
        };
        candidate.push(part);
        match std::fs::symlink_metadata(&candidate) {
            Ok(metadata) if !metadata.file_type().is_symlink() => {}
            _ => return (StatusCode::NOT_FOUND, "file not found").into_response(),
        }
    }

    let is_regular_file = std::fs::metadata(&candidate)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false);
    if !is_regular_file {
        return (StatusCode::NOT_FOUND, "file not found").into_response();
    }

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

async fn not_found() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, "not found")
}

#[cfg(test)]
mod tests {
    use super::*;

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
