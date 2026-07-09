use axum::{http::StatusCode, response::Html, response::IntoResponse, routing::get, Router};
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Minimal HTML shell embedded in the binary.
///
/// File discovery, the explorer UI, code rendering, and prompt generation
/// are out of scope for this scaffold (see issue #2); they land in later
/// issues.
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
/// Only `/{token}` responds with the HTML shell; every other path,
/// including the bare root `/`, returns 404 so the server cannot be used
/// without the session token.
pub fn build_router(token: &str) -> Router {
    Router::new()
        .route(&format!("/{token}"), get(serve_shell))
        .fallback(not_found)
}

async fn serve_shell() -> impl IntoResponse {
    Html(INDEX_HTML)
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
    fn generate_session_token_is_unique_each_call() {
        let a = generate_session_token();
        let b = generate_session_token();
        assert_ne!(a, b);
        assert!(!a.is_empty());
    }
}
