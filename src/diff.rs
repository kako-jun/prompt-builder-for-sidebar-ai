//! Git diff support (issue #8): reads whatever local changes exist in the
//! selected root's working tree without ever modifying the repository -- no
//! `git add`, no staging, no commits. Every command run here is read-only,
//! matching the same "never mutate the user's project" invariant the rest of
//! this tool already holds for file discovery and reading.

use crate::discovery::is_probably_binary;
use std::path::{Component, Path};
use std::process::Command;

/// The result of [`compute_diff`]: whether `root` is a Git working tree at
/// all, and (if so) the combined diff text.
///
/// Tracked changes (staged and unstaged, relative to `HEAD`) come first,
/// followed by one synthesized "new file" block per untracked file. Kept as
/// one flat string rather than a list of per-file entries: `git diff`'s own
/// `diff --git a/<path> b/<path>` headers already delimit file boundaries
/// unambiguously, and the synthesized untracked blocks below reuse the
/// identical header convention so the whole document stays consistent
/// whether a given block came from Git itself or was synthesized here.
pub struct DiffResult {
    pub is_git_repo: bool,
    pub diff: String,
}

/// Computes the current Git diff for `root`, degrading gracefully instead of
/// erroring whenever there's nothing meaningful to show:
///
/// - `root` isn't inside a Git working tree at all (including the `git`
///   binary not being installed) -> `is_git_repo: false`, `diff: ""`.
/// - `root` is a Git repository with no local changes -> `is_git_repo:
///   true`, `diff: ""`.
/// - A brand new repository with no commits yet -- so there is no `HEAD` to
///   diff tracked changes against -- skips the tracked-file pass rather than
///   erroring; any untracked files still show up via the untracked-file pass
///   below, independent of whether the tracked pass succeeded.
pub fn compute_diff(root: &Path) -> DiffResult {
    if !is_git_work_tree(root) {
        return DiffResult {
            is_git_repo: false,
            diff: String::new(),
        };
    }

    let mut sections = Vec::new();

    if let Some(tracked) = run_git_diff_head(root) {
        if !tracked.trim().is_empty() {
            sections.push(tracked);
        }
    }

    for path in list_untracked_files(root) {
        if let Some(block) = synthesize_untracked_diff(root, &path) {
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

/// Runs `git -C root diff HEAD --`, returning its stdout as UTF-8 text, or
/// `None` if the command fails outright (most commonly: a repository with no
/// commits yet, so there is no `HEAD` to diff against -- `git` exits
/// non-zero with "fatal: bad revision 'HEAD'" in that case) or its output
/// isn't valid UTF-8. `git diff HEAD` (as opposed to a plain `git diff`, or
/// `git diff --cached`) compares the working tree directly against `HEAD`,
/// which is what surfaces staged and unstaged changes -- including a staged
/// new file, which `git` itself already renders as a "new file mode" block
/// -- together in one pass; the trailing `--` stops `git` from ever
/// interpreting an unlucky `root` path as a revision.
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

    String::from_utf8(output.stdout).ok()
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

    let Ok(stdout) = String::from_utf8(output.stdout) else {
        return Vec::new();
    };

    stdout
        .split('\0')
        .filter_map(|entry| entry.strip_prefix("?? "))
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Reads `path` (already reported by Git as untracked, `/`-separated and
/// relative to `root`) and formats it as a synthesized "new file" diff
/// block, using the same `diff --git a/<path> b/<path>` header convention a
/// real `git diff` uses for an added file.
///
/// Returns `None` -- silently omitting just that one file rather than
/// failing the whole diff -- for anything this tool already refuses to serve
/// as file content elsewhere: a path escaping `root` or passing through a
/// symlink (the same component-by-component, symlink-checking discipline
/// `serve_file` uses for `/api/file`; Git itself never reports such a path
/// here, but re-validating costs nothing and keeps this function correct
/// even if that assumption ever stops holding), a non-regular file, a binary
/// file (via [`is_probably_binary`], the same heuristic `/api/tree` and
/// `/api/file` both already use), or content that isn't valid UTF-8.
fn synthesize_untracked_diff(root: &Path, path: &str) -> Option<String> {
    let mut candidate = root.to_path_buf();
    for component in Path::new(path).components() {
        let Component::Normal(part) = component else {
            return None;
        };
        candidate.push(part);
        match std::fs::symlink_metadata(&candidate) {
            Ok(metadata) if !metadata.file_type().is_symlink() => {}
            _ => return None,
        }
    }

    let is_regular_file = std::fs::metadata(&candidate)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false);
    if !is_regular_file {
        return None;
    }

    if is_probably_binary(&candidate).unwrap_or(true) {
        return None;
    }

    let content = std::fs::read_to_string(&candidate).ok()?;

    // Mirrors `buildCodeLines`' line-counting rule on the frontend: a
    // trailing "\n" doesn't count as introducing one more (empty) line.
    let line_count = if content.is_empty() {
        0
    } else {
        content.split('\n').count() - usize::from(content.ends_with('\n'))
    };

    let mut block = format!(
        "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{line_count} @@\n"
    );
    for line in content.split('\n').take(line_count) {
        block.push('+');
        block.push_str(line);
        block.push('\n');
    }

    Some(block)
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
}
