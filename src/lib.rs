use axum::{
    extract::State, http::StatusCode, response::Html, response::IntoResponse, routing::get, Json,
    Router,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

pub mod discovery;

use discovery::{discover_tree, FileEntry};

/// Minimal HTML shell embedded in the binary.
///
/// The explorer UI, code rendering, and prompt generation are out of scope
/// for this scaffold; they land in later issues. File discovery itself is
/// implemented in the `discovery` module and exposed via `/{token}/api/tree`.
const INDEX_HTML: &str = include_str!("../assets/index.html");

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
/// `/{token}/api/tree` walks via [`discovery::discover_tree`].
pub fn build_router(token: &str, root: PathBuf) -> Router {
    let state = Arc::new(root);

    Router::new()
        .route(&format!("/{token}"), get(serve_shell))
        .route(&format!("/{token}/api/tree"), get(serve_tree))
        .fallback(not_found)
        .with_state(state)
}

async fn serve_shell() -> impl IntoResponse {
    Html(INDEX_HTML)
}

async fn serve_tree(State(root): State<Arc<PathBuf>>) -> impl IntoResponse {
    let entries: Vec<FileEntry> = discover_tree(&root);
    Json(entries)
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
