//! Support for using a public GitHub repository URL as `ROOT` (issue #14):
//! detects a `https://github.com/{owner}/{repo}[.git][/tree/{ref}]` URL,
//! shallow-clones it into a temporary directory, and hands that directory
//! back to be treated exactly like any other local root by the rest of the
//! program. No new security logic is needed once the clone exists on disk --
//! `resolve_root`/`discover_tree`/`/api/file` already harden a local
//! directory regardless of how it got there.

use std::path::{Path, PathBuf};
use std::process::Command;

/// A parsed `https://github.com/{owner}/{repo}` root URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubRootUrl {
    pub owner: String,
    pub repo: String,
    /// The `/tree/{ref}` suffix, if any -- a branch or tag name.
    pub git_ref: Option<String>,
}

/// Parses `input` as a `https://github.com/{owner}/{repo}` root URL,
/// optionally followed by a `.git` suffix or a `/tree/{ref}` path segment.
/// Returns `None` for anything else -- including a local path, which is the
/// caller's responsibility to fall back to treating `input` as one.
/// Deliberately conservative: any GitHub URL shape this doesn't recognize
/// (`/blob/...`, `/pull/...`, `/issues/...`, extra path segments after a
/// `/tree/{ref}`, ...) falls through to `None` rather than being guessed at,
/// so an unsupported URL degrades to the existing "not a valid local path"
/// error instead of a confusing wrong clone.
pub fn parse_github_root_url(input: &str) -> Option<GithubRootUrl> {
    let rest = input
        .strip_prefix("https://github.com/")
        .or_else(|| input.strip_prefix("http://github.com/"))?;

    let mut segments = rest.split('/').filter(|segment| !segment.is_empty());
    let owner = segments.next()?;
    let repo_segment = segments.next()?;
    let repo = repo_segment.strip_suffix(".git").unwrap_or(repo_segment);
    // A segment that is *exactly* ".git" (e.g. ".../owner/.git") strips down
    // to an empty repo name; the `filter` above only guarantees the raw
    // segment was non-empty, not what's left after stripping the suffix.
    if repo.is_empty() {
        return None;
    }

    let remaining: Vec<&str> = segments.collect();
    let git_ref = match remaining.as_slice() {
        [] => None,
        ["tree", tail @ ..] if !tail.is_empty() => Some(tail.join("/")),
        _ => return None,
    };

    Some(GithubRootUrl {
        owner: owner.to_string(),
        repo: repo.to_string(),
        git_ref,
    })
}

/// Why [`clone_github_root`] failed, each mapping to a distinct, clear
/// user-facing message via its [`std::fmt::Display`] impl.
#[derive(Debug)]
pub enum CloneError {
    /// The `git` binary isn't on `PATH` at all.
    GitNotInstalled,
    /// `git clone` itself ran but exited non-zero -- covers a private
    /// repository (unauthenticated clone naturally fails), a nonexistent
    /// repository or ref, and network failures alike; `git`'s own stderr is
    /// included since it already names which of these happened.
    CloneFailed(String),
    /// Couldn't even create the temporary directory to clone into.
    TempDirUnavailable(String),
}

impl std::fmt::Display for CloneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CloneError::GitNotInstalled => write!(
                f,
                "git is required to clone a GitHub repository URL; install git and try again"
            ),
            CloneError::CloneFailed(detail) => write!(
                f,
                "failed to clone repository: {detail}\n\
                 (this can happen for a private repository, a nonexistent repository or ref, \
                 or a network issue -- only public repositories are supported)"
            ),
            CloneError::TempDirUnavailable(detail) => write!(
                f,
                "could not create a temporary directory for the clone: {detail}"
            ),
        }
    }
}

impl std::error::Error for CloneError {}

/// Removes its wrapped temporary directory when dropped. Meant to be held as
/// a local variable in `main` so it's tied to process lifetime: it fires on
/// every normal exit path, including after Ctrl+C's graceful shutdown (a
/// plain `return` from `main`, not a `std::process::exit`, so destructors
/// still run), without any separate signal-handling logic of its own.
#[derive(Debug)]
pub struct TempDirGuard(PathBuf);

impl TempDirGuard {
    pub fn path(&self) -> &Path {
        &self.0
    }

    /// Test-only constructor that wraps an arbitrary path in a
    /// [`TempDirGuard`] without going through a real `git clone`
    /// ([`clone_github_root`]). `tests/server.rs` is a separate
    /// integration-test crate, so it cannot see anything gated behind
    /// `#[cfg(test)]` here, and this project already exposes similar
    /// test-supporting `pub` items for the same reason (see
    /// [`crate::build_router_for_test`]'s doc comment). Lets a test exercise
    /// the "switching roots drops the *previous* root's guard immediately"
    /// behavior (issue #11) with a plain scratch directory standing in for a
    /// GitHub-URL clone, instead of needing a real network clone.
    pub fn for_test(path: PathBuf) -> Self {
        TempDirGuard(path)
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        if let Err(err) = std::fs::remove_dir_all(&self.0) {
            eprintln!(
                "warning: could not remove temporary clone directory '{}': {err}",
                self.0.display()
            );
        }
    }
}

/// Shallow-clones `url` (`git clone --depth 1 [-b {ref}]`) into a fresh
/// temporary directory and returns it wrapped in a [`TempDirGuard`]. The
/// directory is created (and thus already guarded for cleanup) before the
/// clone itself runs, so a failed clone still leaves nothing behind once the
/// returned error is dropped.
pub fn clone_github_root(url: &GithubRootUrl) -> Result<TempDirGuard, CloneError> {
    let temp_dir = std::env::temp_dir().join(format!(
        "prompt-builder-github-root-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&temp_dir)
        .map_err(|err| CloneError::TempDirUnavailable(err.to_string()))?;
    let guard = TempDirGuard(temp_dir.clone());

    let clone_url = format!("https://github.com/{}/{}.git", url.owner, url.repo);

    let mut command = Command::new("git");
    command.arg("clone").arg("--depth").arg("1");
    if let Some(git_ref) = &url.git_ref {
        command.arg("-b").arg(git_ref);
    }
    command.arg(&clone_url).arg(&temp_dir);

    let output = command.output().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            CloneError::GitNotInstalled
        } else {
            CloneError::CloneFailed(err.to_string())
        }
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(CloneError::CloneFailed(stderr));
    }

    Ok(guard)
}

/// Resolves a `ROOT` command-line argument, which may be a local path or a
/// public GitHub repository URL (see [`parse_github_root_url`]). A URL is
/// shallow-cloned into a temporary directory first; either way, the
/// resulting path is validated exactly like any other local root via
/// [`crate::resolve_root`]. This is the single place that owns the "is this
/// a URL, is this a path" decision, so every caller -- today just `main`,
/// potentially a future second binary or integration test -- gets
/// consistent behavior and consistent error formatting for free.
pub fn resolve_root_arg(raw: &str) -> Result<(PathBuf, Option<TempDirGuard>), String> {
    match parse_github_root_url(raw) {
        Some(github_url) => {
            let guard = clone_github_root(&github_url).map_err(|err| err.to_string())?;
            let root = crate::resolve_root(guard.path())?;
            Ok((root, Some(guard)))
        }
        None => {
            let root = crate::resolve_root(Path::new(raw))?;
            Ok((root, None))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_root_arg_resolves_an_existing_local_directory() {
        let (root, guard) = resolve_root_arg(".").expect("current directory should resolve");
        assert!(root.is_dir());
        assert!(guard.is_none());
    }

    #[test]
    fn resolve_root_arg_rejects_a_missing_local_path() {
        let err = resolve_root_arg("./this-path-should-not-exist-abc123")
            .expect_err("a missing path should be rejected");
        assert!(err.contains("could not be resolved"));
    }

    #[test]
    fn parses_a_plain_owner_repo_url() {
        assert_eq!(
            parse_github_root_url("https://github.com/owner/repo"),
            Some(GithubRootUrl {
                owner: "owner".to_string(),
                repo: "repo".to_string(),
                git_ref: None,
            })
        );
    }

    #[test]
    fn strips_a_dot_git_suffix() {
        assert_eq!(
            parse_github_root_url("https://github.com/owner/repo.git"),
            Some(GithubRootUrl {
                owner: "owner".to_string(),
                repo: "repo".to_string(),
                git_ref: None,
            })
        );
    }

    #[test]
    fn parses_a_tree_ref_suffix() {
        assert_eq!(
            parse_github_root_url("https://github.com/owner/repo/tree/main"),
            Some(GithubRootUrl {
                owner: "owner".to_string(),
                repo: "repo".to_string(),
                git_ref: Some("main".to_string()),
            })
        );
    }

    #[test]
    fn joins_a_multi_segment_ref_back_together() {
        // A branch name containing a slash, e.g. "feature/foo", renders in
        // GitHub's own URLs as multiple path segments after "/tree/".
        assert_eq!(
            parse_github_root_url("https://github.com/owner/repo/tree/feature/foo"),
            Some(GithubRootUrl {
                owner: "owner".to_string(),
                repo: "repo".to_string(),
                git_ref: Some("feature/foo".to_string()),
            })
        );
    }

    #[test]
    fn accepts_a_trailing_slash_with_no_ref() {
        assert_eq!(
            parse_github_root_url("https://github.com/owner/repo/"),
            Some(GithubRootUrl {
                owner: "owner".to_string(),
                repo: "repo".to_string(),
                git_ref: None,
            })
        );
    }

    #[test]
    fn rejects_a_plain_local_path() {
        assert_eq!(parse_github_root_url("."), None);
        assert_eq!(parse_github_root_url("../some/relative/path"), None);
        assert_eq!(parse_github_root_url("/absolute/path"), None);
    }

    #[test]
    fn rejects_a_non_github_url() {
        assert_eq!(parse_github_root_url("https://gitlab.com/owner/repo"), None);
    }

    #[test]
    fn rejects_a_url_missing_the_repo_segment() {
        assert_eq!(parse_github_root_url("https://github.com/owner"), None);
        assert_eq!(parse_github_root_url("https://github.com/"), None);
        assert_eq!(parse_github_root_url("https://github.com"), None);
    }

    #[test]
    fn rejects_a_repo_segment_that_is_only_a_dot_git_suffix() {
        // Stripping ".git" from a segment that is *exactly* ".git" leaves an
        // empty repo name, which must not be treated as a valid (empty)
        // repository.
        assert_eq!(parse_github_root_url("https://github.com/owner/.git"), None);
    }

    #[test]
    fn rejects_an_unsupported_path_shape() {
        // "/blob/...", "/pull/...", "/issues/...", and similar GitHub URL
        // shapes are not a repository root and are deliberately not guessed
        // at -- they fall through to `None`, not a wrong clone.
        assert_eq!(
            parse_github_root_url("https://github.com/owner/repo/blob/main/README.md"),
            None
        );
        assert_eq!(
            parse_github_root_url("https://github.com/owner/repo/pull/1"),
            None
        );
    }

    #[test]
    fn rejects_a_tree_url_with_no_ref_after_it() {
        assert_eq!(
            parse_github_root_url("https://github.com/owner/repo/tree"),
            None
        );
        assert_eq!(
            parse_github_root_url("https://github.com/owner/repo/tree/"),
            None
        );
    }

    #[test]
    fn accepts_http_as_well_as_https() {
        assert_eq!(
            parse_github_root_url("http://github.com/owner/repo"),
            Some(GithubRootUrl {
                owner: "owner".to_string(),
                repo: "repo".to_string(),
                git_ref: None,
            })
        );
    }
}
