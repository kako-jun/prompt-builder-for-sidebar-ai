//! Git diff support (issue #8): reads whatever local changes exist in the
//! selected root's working tree without ever modifying the repository -- no
//! `git add`, no staging, no commits. Every command run here is read-only,
//! matching the same "never mutate the user's project" invariant the rest of
//! this tool already holds for file discovery and reading.

use crate::discovery::{is_probably_binary, resolve_regular_file};
use std::path::Path;
use std::process::Command;

/// The result of [`compute_diff`]: whether `root` is a Git working tree at
/// all, and (if so) the combined diff text.
///
/// Tracked changes (staged and unstaged, relative to `HEAD`) come first,
/// followed by one synthesized "new file" block per untracked file. Kept as
/// one flat string rather than a list of per-file entries: `git diff`'s own
/// `diff --git a/<path> b/<path>` headers already delimit file boundaries
/// unambiguously, and the synthesized untracked blocks below reuse the
/// identical header convention (produced by `git` itself, not hand-rolled --
/// see [`synthesize_untracked_diff`]) so the whole document stays consistent
/// whether a given block came from Git's own tracked-diff pass or the
/// untracked-file pass.
pub struct DiffResult {
    pub is_git_repo: bool,
    pub diff: String,
}

/// Computes the current Git diff for `root`, degrading gracefully instead of
/// erroring whenever there's nothing meaningful to show:
///
/// - `root` can't be canonicalized, or isn't inside a Git working tree at
///   all (including the `git` binary not being installed) -> `is_git_repo:
///   false`, `diff: ""`.
/// - `root` is a Git repository with no local changes -> `is_git_repo:
///   true`, `diff: ""`.
/// - A brand new repository with no commits yet -- so there is no `HEAD` to
///   diff tracked changes against -- skips the tracked-file pass rather than
///   erroring; any untracked files still show up via the untracked-file pass
///   below, independent of whether the tracked pass succeeded.
///
/// `root` is canonicalized once, up front, and every subsequent `git`
/// invocation and path check uses that canonical path -- mirroring
/// `serve_file`'s own re-canonicalization in `src/lib.rs` (see its doc
/// comment for why: it keeps this function correct regardless of what the
/// caller passed as `root`, e.g. a test harness that skips `resolve_root`,
/// rather than only the untracked-file pass's per-component symlink checks
/// being anchored to a possibly-non-canonical root).
pub fn compute_diff(root: &Path) -> DiffResult {
    let Ok(canonical_root) = std::fs::canonicalize(root) else {
        return DiffResult {
            is_git_repo: false,
            diff: String::new(),
        };
    };

    if !is_git_work_tree(&canonical_root) {
        return DiffResult {
            is_git_repo: false,
            diff: String::new(),
        };
    }

    let mut sections = Vec::new();

    if let Some(tracked) = run_git_diff_head(&canonical_root) {
        if !tracked.trim().is_empty() {
            sections.push(tracked);
        }
    }

    for path in list_untracked_files(&canonical_root) {
        if let Some(block) = synthesize_untracked_diff(&canonical_root, &path) {
            sections.push(block);
        }
    }

    DiffResult {
        is_git_repo: true,
        diff: sections.join("\n"),
    }
}

/// Runs `git -C root rev-parse --is-inside-work-tree` and reports whether it
/// printed `true`. Covers both "not a Git repository" and "the `git` binary
/// isn't installed at all" with the same graceful `false` -- this function
/// never panics or propagates a process-spawn error, since either case
/// should read to callers exactly like "there's no diff to show", not like a
/// server error.
fn is_git_work_tree(root: &Path) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|output| output.status.success() && output.stdout.starts_with(b"true"))
        .unwrap_or(false)
}

/// Runs `git -C root diff HEAD --`, returning its stdout as text, or `None`
/// if the command fails outright (most commonly: a repository with no
/// commits yet, so there is no `HEAD` to diff against -- `git` exits
/// non-zero with "fatal: bad revision 'HEAD'" in that case). `git diff HEAD`
/// (as opposed to a plain `git diff`, or `git diff --cached`) compares the
/// working tree directly against `HEAD`, which is what surfaces staged and
/// unstaged changes -- including a staged new file, which `git` itself
/// already renders as a "new file mode" block -- together in one pass; the
/// trailing `--` stops `git` from ever interpreting an unlucky `root` path
/// as a revision.
///
/// Decodes with [`String::from_utf8_lossy`] rather than strict
/// [`String::from_utf8`]: the combined output can cover many files' hunks in
/// one stream, and a single tracked file containing non-UTF-8 bytes (a
/// legacy-encoded text file that isn't caught by `is_probably_binary`'s
/// NUL-byte heuristic, since NUL bytes and invalid UTF-8 are different
/// things) would otherwise fail the *entire* conversion -- silently dropping
/// every other, perfectly valid file's diff along with it, which is far
/// worse than a few replacement characters in the one problem file's hunk.
fn run_git_diff_head(root: &Path) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["diff", "HEAD", "--"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Lists every untracked file beneath `root` (paths relative to `root`,
/// `/`-separated) via `git status --porcelain=v1 --untracked-files=all -z`.
///
/// `--untracked-files=all` recurses into untracked directories and lists
/// their files individually rather than collapsing a whole directory into
/// one entry, matching how [`crate::discovery::discover_tree`] already
/// presents a flat file list. `-z` switches the output to NUL-separated,
/// unquoted entries -- without it, a path containing a space or non-ASCII
/// character comes back double-quoted with C-style escape sequences that
/// would need their own parser; `-z` sidesteps that entirely. Returns an
/// empty list (rather than erroring) if the command fails for any reason.
///
/// Known gap: a repository with no commits yet that also has something
/// staged (`git add`ed before the first commit) won't surface that file
/// here either -- `git status --porcelain` reports a staged-added file with
/// an `A ` prefix, not `??`, and this function only recognizes `??`. See
/// README.md's "Known limitations" for the user-facing note.
fn list_untracked_files(root: &Path) -> Vec<String> {
    let output = match Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["status", "--porcelain=v1", "--untracked-files=all", "-z"])
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => return Vec::new(),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);

    stdout
        .split('\0')
        .filter_map(|entry| entry.strip_prefix("?? "))
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Formats `path` (already reported by Git as untracked, `/`-separated and
/// relative to `root`) as a "new file" diff block, by asking Git itself to
/// produce it (`git diff --no-index -- /dev/null <path>`) rather than
/// hand-rolling the unified-diff format. Letting `git` own this means every
/// detail -- the file's actual mode bits (so an executable untracked script
/// is correctly reported as `new file mode 100755`, not a hand-rolled
/// hardcoded `100644`), the `\ No newline at end of file` marker, and
/// omitting the hunk header entirely for a genuinely empty file (a hand-
/// rolled `@@ -0,0 +1,0 @@` would be non-standard output real `git diff`
/// never produces) -- is inherited for free instead of being independently
/// (and only partially) reimplemented here.
///
/// Returns `None` -- silently omitting just that one file rather than
/// failing the whole diff -- for anything this tool already refuses to serve
/// as file content elsewhere: a path escaping `root` or passing through a
/// symlink (via [`resolve_regular_file`], the same discipline `serve_file`
/// uses for `/api/file`; Git itself never reports such a path here, but
/// re-validating costs nothing and keeps this function correct even if that
/// assumption ever stops holding), a non-regular file, a binary file (via
/// [`is_probably_binary`], the same heuristic `/api/tree` and `/api/file`
/// both already use -- checked before ever invoking `git`, so a binary
/// file's content is never even offered to `git diff`, rather than relying
/// on `git`'s own "Binary files ... differ" output), or the `git`
/// invocation itself failing outright.
///
/// `--no-index` exits `1` (not `0`) whenever a difference is found, which is
/// *always* true here since the left-hand side is `/dev/null` -- so exit `1`
/// is this command's expected success case, not a failure; only some other
/// exit code (e.g. a genuine invocation error) is treated as one. Output is
/// decoded with [`String::from_utf8_lossy`] for the same reason
/// [`run_git_diff_head`] does.
fn synthesize_untracked_diff(root: &Path, path: &str) -> Option<String> {
    let candidate = resolve_regular_file(root, path)?;

    if is_probably_binary(&candidate).unwrap_or(true) {
        return None;
    }

    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["diff", "--no-index", "--", "/dev/null", path])
        .output()
        .ok()?;

    match output.status.code() {
        Some(0) | Some(1) => Some(String::from_utf8_lossy(&output.stdout).into_owned()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A temporary directory removed on drop, optionally initialized as a
    /// Git repository with a configured local identity (so `git commit`
    /// works even in a CI environment with no global `user.name`/
    /// `user.email` set). Local to this module rather than shared with
    /// `lib.rs`'s own `ScratchDir`, since only this module's tests need a
    /// real Git repository to exercise against.
    struct ScratchRepo(PathBuf);

    impl ScratchRepo {
        fn new(name_hint: &str) -> Self {
            let unique = format!(
                "prompt-builder-diff-{name_hint}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("system clock should be after the epoch")
                    .as_nanos()
            );
            let path = std::env::temp_dir().join(unique);
            std::fs::create_dir_all(&path).expect("should create a scratch directory");
            ScratchRepo(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn git(&self, args: &[&str]) {
            let status = Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args(args)
                .status()
                .expect("git should be installed and runnable");
            assert!(status.success(), "git {args:?} should succeed");
        }

        fn init(name_hint: &str) -> Self {
            let repo = Self::new(name_hint);
            repo.git(&["init", "-q"]);
            repo.git(&["config", "user.email", "test@example.com"]);
            repo.git(&["config", "user.name", "Test"]);
            repo
        }

        fn write(&self, relative: &str, content: &str) {
            let full = self.0.join(relative);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).expect("should create parent directories");
            }
            std::fs::write(full, content).expect("should write the file");
        }

        fn commit_all(&self, message: &str) {
            self.git(&["add", "-A"]);
            self.git(&["commit", "-q", "-m", message]);
        }
    }

    impl Drop for ScratchRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_non_git_directory_degrades_gracefully() {
        let scratch = ScratchRepo::new("non-git");
        // Deliberately not initialized as a Git repository.
        let result = compute_diff(scratch.path());
        assert!(!result.is_git_repo);
        assert_eq!(result.diff, "");
    }

    #[test]
    fn an_empty_repository_with_no_commits_degrades_gracefully() {
        let repo = ScratchRepo::init("empty-no-commits");
        let result = compute_diff(repo.path());
        assert!(result.is_git_repo);
        assert_eq!(result.diff, "");
    }

    #[test]
    fn a_clean_repository_with_no_local_changes_has_an_empty_diff() {
        let repo = ScratchRepo::init("clean");
        repo.write("a.txt", "hello\n");
        repo.commit_all("init");

        let result = compute_diff(repo.path());
        assert!(result.is_git_repo);
        assert_eq!(result.diff, "");
    }

    #[test]
    fn a_modified_tracked_file_is_included() {
        let repo = ScratchRepo::init("modified");
        repo.write("a.txt", "hello\n");
        repo.commit_all("init");
        repo.write("a.txt", "hello world\n");

        let result = compute_diff(repo.path());
        assert!(result.diff.contains("diff --git a/a.txt b/a.txt"));
        assert!(result.diff.contains("-hello"));
        assert!(result.diff.contains("+hello world"));
    }

    #[test]
    fn a_staged_added_file_is_included() {
        let repo = ScratchRepo::init("added");
        repo.write("a.txt", "hello\n");
        repo.commit_all("init");
        repo.write("added.txt", "new content\n");
        repo.git(&["add", "added.txt"]);

        let result = compute_diff(repo.path());
        assert!(result.diff.contains("diff --git a/added.txt b/added.txt"));
        assert!(result.diff.contains("new file mode"));
        assert!(result.diff.contains("+new content"));
    }

    #[test]
    fn a_deleted_tracked_file_is_included() {
        let repo = ScratchRepo::init("deleted");
        repo.write("a.txt", "hello\n");
        repo.commit_all("init");
        std::fs::remove_file(repo.path().join("a.txt")).expect("should remove the file");

        let result = compute_diff(repo.path());
        assert!(result.diff.contains("diff --git a/a.txt b/a.txt"));
        assert!(result.diff.contains("deleted file mode"));
        assert!(result.diff.contains("+++ /dev/null"));
    }

    #[test]
    fn an_untracked_file_is_synthesized_as_a_new_file_block() {
        let repo = ScratchRepo::init("untracked");
        repo.write("a.txt", "hello\n");
        repo.commit_all("init");
        repo.write("untracked.txt", "line one\nline two\n");

        let result = compute_diff(repo.path());
        assert!(result
            .diff
            .contains("diff --git a/untracked.txt b/untracked.txt"));
        assert!(result.diff.contains("new file mode 100644"));
        assert!(result.diff.contains("--- /dev/null"));
        assert!(result.diff.contains("+++ b/untracked.txt"));
        assert!(result.diff.contains("@@ -0,0 +1,2 @@"));
        assert!(result.diff.contains("+line one"));
        assert!(result.diff.contains("+line two"));
    }

    #[test]
    fn an_untracked_file_in_a_nested_directory_uses_its_relative_path() {
        let repo = ScratchRepo::init("untracked-nested");
        repo.write("a.txt", "hello\n");
        repo.commit_all("init");
        repo.write("sub/dir/nested.txt", "content\n");

        let result = compute_diff(repo.path());
        assert!(result
            .diff
            .contains("diff --git a/sub/dir/nested.txt b/sub/dir/nested.txt"));
    }

    #[test]
    fn multiple_changed_files_each_get_their_own_unambiguous_diff_git_header() {
        let repo = ScratchRepo::init("multi");
        repo.write("a.txt", "hello\n");
        repo.write("b.txt", "world\n");
        repo.commit_all("init");
        repo.write("a.txt", "hello there\n");
        repo.write("new.txt", "brand new\n");

        let result = compute_diff(repo.path());
        let header_count = result.diff.matches("diff --git a/").count();
        assert_eq!(
            header_count, 2,
            "expected exactly one header per changed file: {}",
            result.diff
        );
        assert!(result.diff.contains("diff --git a/a.txt b/a.txt"));
        assert!(result.diff.contains("diff --git a/new.txt b/new.txt"));
    }

    #[test]
    fn a_binary_untracked_file_is_omitted_rather_than_erroring() {
        let repo = ScratchRepo::init("binary");
        repo.write("a.txt", "hello\n");
        repo.commit_all("init");
        std::fs::write(repo.path().join("binary.dat"), [0u8, 1, 2, 3, 0, 4])
            .expect("should write the binary file");

        let result = compute_diff(repo.path());
        assert!(!result.diff.contains("binary.dat"));
    }

    #[cfg(unix)]
    #[test]
    fn an_untracked_symlink_is_omitted_rather_than_followed() {
        let repo = ScratchRepo::init("symlink");
        repo.write("a.txt", "hello\n");
        repo.commit_all("init");
        std::fs::write(repo.path().join("real.txt"), "real content\n")
            .expect("should write the real file");
        std::os::unix::fs::symlink(repo.path().join("real.txt"), repo.path().join("link.txt"))
            .expect("should create the symlink");

        let result = compute_diff(repo.path());
        assert!(!result.diff.contains("link.txt"));
    }

    #[test]
    fn an_empty_untracked_file_produces_no_hunk_matching_real_gits_own_behavior() {
        let repo = ScratchRepo::init("empty-untracked");
        repo.write("a.txt", "hello\n");
        repo.commit_all("init");
        std::fs::write(repo.path().join("empty.txt"), []).expect("should create the empty file");

        let result = compute_diff(repo.path());
        assert!(result.diff.contains("diff --git a/empty.txt b/empty.txt"));
        assert!(result.diff.contains("new file mode 100644"));
        // Real `git diff` emits no hunk (no `---`/`+++`/`@@` lines) for a
        // genuinely empty added file; the old hand-rolled formatter emitted
        // a non-standard `@@ -0,0 +1,0 @@` here.
        assert!(!result.diff.contains("@@"));
    }

    #[cfg(unix)]
    #[test]
    fn an_untracked_executable_files_mode_bit_is_preserved() {
        use std::os::unix::fs::PermissionsExt;

        let repo = ScratchRepo::init("executable-untracked");
        repo.write("a.txt", "hello\n");
        repo.commit_all("init");
        repo.write("script.sh", "#!/bin/sh\necho hi\n");
        let script_path = repo.path().join("script.sh");
        let mut permissions = std::fs::metadata(&script_path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script_path, permissions).unwrap();

        let result = compute_diff(repo.path());
        assert!(
            result.diff.contains("new file mode 100755"),
            "expected the executable bit to be preserved: {}",
            result.diff
        );
    }

    #[test]
    fn a_modified_tracked_files_invalid_utf8_content_does_not_silently_drop_other_diffs() {
        let repo = ScratchRepo::init("invalid-utf8");
        repo.write("a.txt", "hello\n");
        repo.write("b.txt", "world\n");
        repo.commit_all("init");
        repo.write("a.txt", "hello there\n");
        // Invalid UTF-8: a lone continuation byte.
        std::fs::write(
            repo.path().join("b.txt"),
            [b'w', b'o', 0xC3, b'r', b'l', b'd'],
        )
        .expect("should write invalid-UTF-8 content");

        let result = compute_diff(repo.path());
        assert!(
            result.diff.contains("diff --git a/a.txt b/a.txt"),
            "a.txt's valid diff should not be dropped just because b.txt's content isn't valid UTF-8: {}",
            result.diff
        );
        assert!(result.diff.contains("+hello there"));
    }
}
