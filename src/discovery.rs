//! Safe file discovery for the selected root directory.
//!
//! Walks the root with the `ignore` crate, respects `.gitignore`, and applies
//! a small set of baseline safety rules on top of it: `.git` and common
//! dependency/build directories are always excluded even without a
//! `.gitignore`, symlinks are never followed (so a symlink cannot be used to
//! read or list anything outside the selected root), non-regular files
//! (named pipes, device files, sockets, ...) are never opened, and files
//! that look like secrets (`.env`, private keys, credential files, ...) are
//! flagged rather than silently hidden.
//!
//! See README.md for the user-facing description of these rules and their
//! known limitations.

use ignore::WalkBuilder;
use serde::Serialize;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// Directory names that are always excluded, even when the project has no
/// `.gitignore` of its own. This is a small, non-exhaustive baseline list,
/// not a substitute for a real ignore file.
const BASELINE_EXCLUDED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
];

/// File names that are always treated as likely secrets, regardless of
/// extension (typical SSH key file names have none).
const LIKELY_SECRET_EXACT_NAMES: &[&str] = &[
    "id_rsa",
    "id_rsa.pub",
    "id_dsa",
    "id_dsa.pub",
    "id_ecdsa",
    "id_ecdsa.pub",
    "id_ed25519",
    "id_ed25519.pub",
    ".npmrc",
    ".netrc",
];

/// File extensions that are always treated as likely secrets (private keys
/// and similar credential bundles).
const LIKELY_SECRET_EXTENSIONS: &[&str] = &["pem", "key", "pfx", "p12", "jks"];

/// Number of leading bytes read to decide whether a file is likely binary.
/// Mirrors the simple heuristic git itself uses: if a NUL byte shows up in
/// the first chunk of the file, treat it as binary.
const BINARY_SNIFF_LEN: usize = 8000;

/// A hard cap on how many entries [`discover_tree`] will ever *visit* for a
/// single request (not just how many it collects -- see
/// [`discover_tree_with_limit`]'s doc comment for why that distinction
/// matters). A backstop against a pathological tree (a directory containing
/// an enormous number of files, deliberately or otherwise) consuming
/// unbounded memory and time on every single `/api/tree` request; set far
/// above what any real project's file count looks like, so it is never
/// expected to matter for ordinary use. `pub` so `serve_tree` (`src/lib.rs`)
/// and this crate's tests can both refer to it as documentation of what the
/// cap actually is, even though only [`discover_tree`] itself enforces it.
pub const MAX_TREE_ENTRIES: usize = 50_000;

/// Files above this size are refused (as part of [`resolve_regular_file`]'s
/// own contract) rather than served/diffed in full: a per-file cap meant to
/// keep a single request bounded in memory and time, not a judgment about
/// what counts as "too big" for a prompt -- the frontend's own
/// selection-size statistics and "large selection" warning (issue #8)
/// already handle that concern at a higher level, across a whole selection
/// rather than one file.
pub const MAX_SERVABLE_FILE_SIZE: u64 = 10 * 1024 * 1024;

/// A single file or directory entry in the discovered tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileEntry {
    /// Path relative to the selected root, always `/`-separated regardless
    /// of platform.
    pub path: String,
    pub is_dir: bool,
    /// True when the file name matches a known secret-file pattern (see
    /// [`LIKELY_SECRET_EXACT_NAMES`], [`LIKELY_SECRET_EXTENSIONS`], and the
    /// `.env*` check in [`looks_like_secret`]). Flagged, not excluded: the
    /// entry still appears in the tree.
    pub likely_secret: bool,
}

/// Walks `root` and returns every eligible file and directory entry as a
/// flat, deterministically ordered list (sorted by `path`).
///
/// Excluded, never returned:
/// - `.git` and the [`BASELINE_EXCLUDED_DIRS`] names, plus anything ignored
///   by a `.gitignore` in the tree.
/// - Symlinks (of any kind), so a symlink cannot be used to read or list
///   anything outside `root`.
/// - Non-regular files: named pipes (FIFOs), character/block devices,
///   sockets, and anything else that is neither a directory nor a regular
///   file. These are skipped without ever being opened, since opening one
///   (e.g. a FIFO with no writer) can block indefinitely.
/// - Files that look binary (a NUL byte in the first [`BINARY_SNIFF_LEN`]
///   bytes) or that cannot be read (e.g. a permission error): these are
///   skipped rather than causing the whole walk to fail.
///
/// - Anything beyond the first [`MAX_TREE_ENTRIES`] entries the walk visits
///   (issue #9's resource-limit hardening against a pathological tree): see
///   [`discover_tree_with_limit`]'s doc comment for exactly what "visits"
///   means here and why.
///
/// `root` itself is not included as an entry; only its contents are. Returns
/// `(entries, truncated)`: `truncated` is `true` when the cap above was
/// actually hit, so callers (`serve_tree` in `src/lib.rs`) can tell the
/// difference between "this is genuinely the whole tree" and "this is a
/// cut-off subset" instead of the response looking complete either way.
pub fn discover_tree(root: &Path) -> (Vec<FileEntry>, bool) {
    discover_tree_with_limit(root, MAX_TREE_ENTRIES)
}

/// The actual implementation behind [`discover_tree`], taking `max_entries`
/// as a parameter so tests can exercise the truncation behavior itself
/// (without needing to actually create `MAX_TREE_ENTRIES` real files on
/// disk, which the real constant is deliberately too large to make
/// practical for a fast unit test).
///
/// The cap is enforced against every item the walk *visits* -- incrementing
/// before any of the `continue`s below, including the ones for permission
/// errors, symlinks, and non-regular files -- not just against how many
/// entries end up collected. This matters: entries.len() alone would let a
/// tree dominated by filtered-out items (an enormous number of symlinks, or
/// especially binary files, since checking one means opening and reading it
/// via `is_probably_binary`) blow straight through what looks like a cap
/// without ever tripping it, defeating the whole point of a
/// resource-exhaustion backstop.
///
/// The walk itself is ordered by file name at each directory level
/// (`.sort_by_file_name`) specifically so that *which* entries survive a
/// truncation is deterministic (the same subset every run, ordered the same
/// way `sortedChildren` on the frontend already presents siblings) rather
/// than depending on unspecified directory-enumeration order, which can
/// differ between runs or platforms.
fn discover_tree_with_limit(root: &Path, max_entries: usize) -> (Vec<FileEntry>, bool) {
    let mut entries = Vec::new();
    let mut truncated = false;

    let walker = WalkBuilder::new(root)
        // The `ignore` crate hides dotfiles by default; that would also
        // swallow ordinary dotdirs like `.github` that a project wants
        // visible. Respecting `.gitignore` (left at its default) is enough
        // to hide the dotfiles a project actually wants hidden.
        .hidden(false)
        // Never follow symlinks: this is the primary defense against using
        // a symlink to escape the selected root.
        .follow_links(false)
        // The `ignore` crate only honors `.gitignore` when the walked
        // directory is inside an actual git repository (a `.git` or `.jj`
        // directory is present) by default. The selected root is not
        // guaranteed to be a git repository, so `.gitignore` must be
        // respected unconditionally.
        .require_git(false)
        // Deterministic truncation order (see this function's doc comment).
        .sort_by_file_name(|a, b| a.cmp(b))
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            if name == ".git" {
                return false;
            }
            if entry.file_type().is_some_and(|ft| ft.is_dir())
                && BASELINE_EXCLUDED_DIRS.contains(&name.as_ref())
            {
                return false;
            }
            true
        })
        .build();

    for (visited, result) in walker.enumerate() {
        if visited >= max_entries {
            truncated = true;
            break;
        }

        let entry = match result {
            Ok(entry) => entry,
            // Permission errors and the like on a single entry shouldn't
            // abort the whole walk.
            Err(_) => continue,
        };

        if entry.depth() == 0 {
            continue;
        }

        // Defense in depth on top of `follow_links(false)`: never include a
        // symlink entry itself, and never include anything that somehow
        // resolves outside of `root`.
        if entry.file_type().is_some_and(|ft| ft.is_symlink()) {
            continue;
        }

        let relative = match entry.path().strip_prefix(root) {
            Ok(relative) => relative,
            Err(_) => continue,
        };

        let is_dir = entry.file_type().is_some_and(|ft| ft.is_dir());
        let is_regular_file = entry.file_type().is_some_and(|ft| ft.is_file());

        // Anything that is neither a directory nor a regular file (named
        // pipes/FIFOs, character or block devices, sockets, ...) is skipped
        // unconditionally, the same way symlinks are skipped above, without
        // ever being opened. Opening a FIFO with no writer on the other end
        // blocks forever, which would hang the whole request; there is no
        // safe way to "peek" at one of these before committing to open it.
        if !is_dir && !is_regular_file {
            continue;
        }

        if !is_dir && is_probably_binary(entry.path()).unwrap_or(true) {
            continue;
        }

        let path = normalize_path(relative);
        let likely_secret = !is_dir && looks_like_secret(entry.path());

        entries.push(FileEntry {
            path,
            is_dir,
            likely_secret,
        });
    }

    entries.sort_by(|a, b| a.path.cmp(&b.path));
    (entries, truncated)
}

/// Renders a relative path as a `/`-separated string regardless of the
/// host platform's native separator.
fn normalize_path(relative: &Path) -> String {
    relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// Why [`resolve_regular_file`] rejected a path. Deliberately just two
/// variants: every "this path is unsafe to serve" reason (escapes the root,
/// a symlink anywhere in it, missing, a directory, any other non-regular
/// file) collapses into [`ResolveError::Invalid`] -- callers must not let a
/// response distinguish "outside the root and exists" from "outside the
/// root and doesn't exist" (see `serve_file`'s doc comment in `src/lib.rs`).
/// [`ResolveError::TooLarge`] is kept separate from that on purpose: unlike
/// every traversal/existence reason above, there is nothing sensitive about
/// revealing that a path *inside* the root happens to be oversized, and
/// issue #9 specifically wants "oversized input fails safely and clearly"
/// -- collapsing it into `Invalid` would turn a clear, actionable 400 into
/// an unhelpful 404.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveError {
    Invalid,
    TooLarge,
}

/// Validates `requested_path` (untrusted -- an HTTP query value, a `git
/// status` listing, anything not already known-safe) component by component
/// against `canonical_root` (the caller's responsibility to have already
/// canonicalized), and returns the resulting filesystem path if -- and only
/// if -- every check passes. This is the one path-validation discipline this
/// whole tool relies on wherever an untrusted relative path needs to become
/// a real path beneath the selected root: `/{token}/api/file` (`serve_file`
/// in `src/lib.rs`) and the Git-diff module's untracked-file handling
/// (`synthesize_untracked_diff` in `src/diff.rs`) both call this instead of
/// each maintaining their own copy of the same rules.
///
/// Returns `Err(ResolveError::Invalid)` for any of:
/// - A component that isn't [`Component::Normal`] -- a `..` (`ParentDir`), a
///   leading `/` (`RootDir`/`Prefix`), or a `.` (`CurDir`) -- checked before
///   the filesystem is ever touched, so a path that would escape the root
///   can't be distinguished (by response timing or otherwise) from one that
///   merely doesn't exist.
/// - Any component -- intermediate or final -- that is a symlink (checked
///   with [`std::fs::symlink_metadata`], which does not follow the link
///   itself), matching the same "never follow a symlink" invariant
///   [`discover_tree`] already uses.
/// - A final path that isn't a regular file (missing, a directory, or a
///   non-regular file such as a FIFO/socket/device).
///
/// Returns `Err(ResolveError::TooLarge)` for a final path that passed every
/// check above but is larger than [`MAX_SERVABLE_FILE_SIZE`] (issue #9's
/// resource-limit hardening). The size is read from the same
/// [`std::fs::metadata`] call already needed for the regular-file check
/// above, rather than a second, separate stat of the same path.
pub fn resolve_regular_file(
    canonical_root: &Path,
    requested_path: &str,
) -> Result<PathBuf, ResolveError> {
    let mut candidate = canonical_root.to_path_buf();
    for component in Path::new(requested_path).components() {
        let Component::Normal(part) = component else {
            return Err(ResolveError::Invalid);
        };
        candidate.push(part);
        match std::fs::symlink_metadata(&candidate) {
            Ok(metadata) if !metadata.file_type().is_symlink() => {}
            _ => return Err(ResolveError::Invalid),
        }
    }

    let metadata = std::fs::metadata(&candidate).map_err(|_| ResolveError::Invalid)?;
    if !metadata.file_type().is_file() {
        return Err(ResolveError::Invalid);
    }
    if metadata.len() > MAX_SERVABLE_FILE_SIZE {
        return Err(ResolveError::TooLarge);
    }

    Ok(candidate)
}

/// Reads up to [`BINARY_SNIFF_LEN`] bytes of `path` and returns whether a
/// NUL byte appears in that prefix. Read failures (e.g. permission denied)
/// are surfaced as `Err` so the caller can skip the entry instead of
/// panicking.
///
/// Public so `/{token}/api/file` (see `src/lib.rs`) can reuse the exact same
/// heuristic instead of duplicating it: a file this function excludes from
/// the tree must also be refused by the single-file endpoint.
pub fn is_probably_binary(path: &Path) -> std::io::Result<bool> {
    let file = std::fs::File::open(path)?;
    let mut buffer = Vec::with_capacity(BINARY_SNIFF_LEN);
    file.take(BINARY_SNIFF_LEN as u64)
        .read_to_end(&mut buffer)?;
    Ok(buffer.contains(&0))
}

/// Baseline, non-exhaustive check for file names that commonly hold
/// secrets. Matching files are flagged via `likely_secret`, not excluded;
/// hardening this list further is out of scope here (see issue #9).
///
/// All three checks below are case-insensitive: `likely_secret` exists to
/// warn before a secret is fed into an AI prompt, and a missed match (false
/// negative) is worse than an over-eager one, so `ID_RSA`, `.ENV`, and
/// `CERT.PEM` are flagged exactly like their lowercase spellings.
fn looks_like_secret(path: &Path) -> bool {
    let Some(file_name) = path
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
    else {
        return false;
    };

    if file_name == ".env" || file_name.starts_with(".env.") {
        return true;
    }

    if LIKELY_SECRET_EXACT_NAMES.contains(&file_name.as_str()) {
        return true;
    }

    if let Some(extension) = path
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
    {
        if LIKELY_SECRET_EXTENSIONS.contains(&extension.as_str()) {
            return true;
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// A directory under the OS temp dir that is removed on drop, mirroring
    /// the `ScratchDir` helper in `src/lib.rs`'s tests.
    struct ScratchDir(PathBuf);

    impl ScratchDir {
        fn new(name_hint: &str) -> Self {
            let unique = format!(
                "prompt-builder-discovery-{name_hint}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("system clock should be after the epoch")
                    .as_nanos()
            );
            let path = std::env::temp_dir().join(unique);
            fs::create_dir_all(&path).expect("should create a scratch directory");
            ScratchDir(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn discovers_plain_text_files_in_stable_order() {
        let scratch = ScratchDir::new("basic");
        let root = scratch.path();
        fs::write(root.join("b.txt"), "b").unwrap();
        fs::write(root.join("a.txt"), "a").unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub/c.txt"), "c").unwrap();

        let (entries, _) = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert_eq!(paths, vec!["a.txt", "b.txt", "sub", "sub/c.txt"]);
        assert!(entries.iter().all(|e| !e.likely_secret));
    }

    #[test]
    fn excludes_git_and_baseline_directories() {
        let scratch = ScratchDir::new("baseline-excludes");
        let root = scratch.path();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "irrelevant").unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/pkg.js"), "irrelevant").unwrap();
        fs::write(root.join("kept.txt"), "kept").unwrap();

        let (entries, _) = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert_eq!(paths, vec!["kept.txt"]);
    }

    #[test]
    fn respects_gitignore() {
        let scratch = ScratchDir::new("gitignore");
        let root = scratch.path();
        fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(root.join("ignored.txt"), "ignored").unwrap();
        fs::write(root.join("kept.txt"), "kept").unwrap();

        let (entries, _) = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(paths.contains(&"kept.txt"));
        assert!(!paths.contains(&"ignored.txt"));
    }

    #[test]
    fn keeps_ordinary_dotdirs_visible() {
        let scratch = ScratchDir::new("dotdirs");
        let root = scratch.path();
        fs::create_dir(root.join(".github")).unwrap();
        fs::write(root.join(".github/workflow.yml"), "workflow").unwrap();

        let (entries, _) = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(paths.contains(&".github"));
        assert!(paths.contains(&".github/workflow.yml"));
    }

    #[test]
    fn excludes_binary_files() {
        let scratch = ScratchDir::new("binary");
        let root = scratch.path();
        fs::write(root.join("text.txt"), "hello").unwrap();
        fs::write(root.join("binary.bin"), [0u8, 1, 2, 3]).unwrap();

        let (entries, _) = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(paths.contains(&"text.txt"));
        assert!(!paths.contains(&"binary.bin"));
    }

    #[test]
    fn flags_likely_secret_files_without_excluding_them() {
        let scratch = ScratchDir::new("secrets");
        let root = scratch.path();
        fs::write(root.join(".env"), "SECRET=1").unwrap();
        fs::write(root.join(".env.local"), "SECRET=2").unwrap();
        fs::write(root.join("id_rsa"), "not a real key").unwrap();
        fs::write(root.join("cert.pem"), "not a real cert").unwrap();
        fs::write(root.join(".npmrc"), "//registry").unwrap();
        fs::write(root.join("normal.txt"), "nothing to see here").unwrap();

        let (entries, _) = discover_tree(root);
        let secret_flag = |name: &str| {
            entries
                .iter()
                .find(|e| e.path == name)
                .unwrap_or_else(|| panic!("expected an entry for {name}"))
                .likely_secret
        };

        assert!(secret_flag(".env"));
        assert!(secret_flag(".env.local"));
        assert!(secret_flag("id_rsa"));
        assert!(secret_flag("cert.pem"));
        assert!(secret_flag(".npmrc"));
        assert!(!secret_flag("normal.txt"));

        // Secret files are flagged, not excluded: they still appear.
        assert_eq!(entries.iter().filter(|e| e.likely_secret).count(), 5);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks_out_of_root() {
        let scratch = ScratchDir::new("symlink-root");
        let outside = ScratchDir::new("symlink-outside");
        fs::write(outside.path().join("secret.txt"), "outside root").unwrap();

        let root = scratch.path();
        fs::write(root.join("kept.txt"), "kept").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("escape")).unwrap();

        let (entries, _) = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert_eq!(paths, vec!["kept.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_include_a_symlinked_file() {
        let scratch = ScratchDir::new("symlink-file");
        let root = scratch.path();
        fs::write(root.join("real.txt"), "real").unwrap();
        std::os::unix::fs::symlink(root.join("real.txt"), root.join("link.txt")).unwrap();

        let (entries, _) = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(paths.contains(&"real.txt"));
        assert!(!paths.contains(&"link.txt"));
    }

    #[test]
    fn respects_nested_gitignore_in_subdirectory() {
        let scratch = ScratchDir::new("nested-gitignore");
        let root = scratch.path();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub/.gitignore"), "ignored.txt\n").unwrap();
        fs::write(root.join("sub/ignored.txt"), "ignored in sub").unwrap();
        fs::write(root.join("sub/kept.txt"), "kept in sub").unwrap();
        // Same file name at root: the sub/.gitignore pattern must not reach
        // outside the directory it lives in.
        fs::write(root.join("ignored.txt"), "kept at root").unwrap();

        let (entries, _) = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(paths.contains(&"sub/kept.txt"));
        assert!(!paths.contains(&"sub/ignored.txt"));
        assert!(
            paths.contains(&"ignored.txt"),
            "root-level file with the same name should be unaffected by the nested .gitignore: {paths:?}"
        );
    }

    #[test]
    fn respects_gitignore_negation_pattern() {
        let scratch = ScratchDir::new("gitignore-negation");
        let root = scratch.path();
        fs::write(root.join(".gitignore"), "*.log\n!keep.log\n").unwrap();
        fs::write(root.join("debug.log"), "debug").unwrap();
        fs::write(root.join("keep.log"), "keep").unwrap();

        let (entries, _) = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(!paths.contains(&"debug.log"));
        assert!(paths.contains(&"keep.log"));
    }

    #[test]
    fn baseline_excluded_dir_is_not_restored_by_gitignore_negation() {
        let scratch = ScratchDir::new("baseline-vs-negation");
        let root = scratch.path();
        // A `!node_modules` negation is a plausible thing for a project to
        // add to its .gitignore; the baseline safety exclusion must still
        // win, since it is not implemented via the gitignore matcher.
        fs::write(root.join(".gitignore"), "!node_modules\n").unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/pkg.js"), "irrelevant").unwrap();
        fs::write(root.join("kept.txt"), "kept").unwrap();

        let (entries, _) = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(paths.contains(&"kept.txt"));
        assert!(
            !paths.contains(&"node_modules") && !paths.contains(&"node_modules/pkg.js"),
            "baseline exclusion should not be overridden by a .gitignore negation: {paths:?}"
        );
    }

    #[test]
    fn file_named_like_baseline_dir_is_not_excluded() {
        let scratch = ScratchDir::new("file-named-like-baseline-dir");
        let root = scratch.path();
        // "target" is a baseline-excluded *directory* name; a plain file
        // that happens to share the name should not be swept up, since the
        // baseline check is gated on `is_dir`.
        fs::write(root.join("target"), "not a directory").unwrap();

        let (entries, _) = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(paths.contains(&"target"));
    }

    #[test]
    fn flags_secret_extension_case_insensitively() {
        let scratch = ScratchDir::new("secret-extension-case");
        let root = scratch.path();
        fs::write(root.join("CERT.PEM"), "not a real cert").unwrap();

        let (entries, _) = discover_tree(root);
        let entry = entries
            .iter()
            .find(|e| e.path == "CERT.PEM")
            .expect("expected an entry for CERT.PEM");

        assert!(entry.likely_secret);
    }

    #[test]
    fn flags_uppercase_env_and_exact_name_variants_case_insensitively() {
        // All three `looks_like_secret` checks (the `.env*` prefix check,
        // the exact-name list, and the extension list) are case-insensitive,
        // matching the existing `flags_secret_extension_case_insensitively`
        // behavior: a missed secret (false negative) is worse than an
        // over-eager flag, so uppercase variants must still be flagged.
        let scratch = ScratchDir::new("uppercase-secret-variants");
        let root = scratch.path();
        fs::write(root.join(".ENV"), "SECRET=1").unwrap();
        fs::write(root.join("ID_RSA"), "not a real key").unwrap();
        fs::write(root.join(".NPMRC"), "//registry").unwrap();

        let (entries, _) = discover_tree(root);
        let secret_flag = |name: &str| {
            entries
                .iter()
                .find(|e| e.path == name)
                .unwrap_or_else(|| panic!("expected an entry for {name}"))
                .likely_secret
        };

        assert!(secret_flag(".ENV"));
        assert!(secret_flag("ID_RSA"));
        assert!(secret_flag(".NPMRC"));
    }

    #[test]
    fn flags_env_example_as_likely_secret() {
        // Known behavior (reported, not fixed here): `starts_with(".env.")`
        // flags harmless templates like `.env.example` along with real
        // `.env.*` files. Whether to special-case template-like names is a
        // review/kako-jun decision, not made in this test.
        let scratch = ScratchDir::new("env-example");
        let root = scratch.path();
        fs::write(root.join(".env.example"), "SECRET=changeme").unwrap();

        let (entries, _) = discover_tree(root);
        let entry = entries
            .iter()
            .find(|e| e.path == ".env.example")
            .expect("expected an entry for .env.example");

        assert!(entry.likely_secret);
    }

    #[test]
    fn binary_pfx_secret_file_is_silently_excluded_not_flagged() {
        // Known inconsistency (reported, not fixed here): the binary check
        // runs before `likely_secret` is ever computed, so a secret-looking
        // file that is also binary is excluded outright instead of being
        // flagged and kept, contradicting the "flag, don't hide" intent for
        // secret files. Whether to reorder the checks is a review/kako-jun
        // decision, not made in this test.
        let scratch = ScratchDir::new("binary-secret");
        let root = scratch.path();
        fs::write(root.join("cert.pfx"), [0u8, 1, 2, 3]).unwrap();

        let (entries, _) = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(!paths.contains(&"cert.pfx"));
    }

    #[test]
    fn empty_root_directory_returns_no_entries() {
        let scratch = ScratchDir::new("empty-root");
        let root = scratch.path();

        let (entries, _) = discover_tree(root);

        assert!(entries.is_empty());
    }

    #[test]
    fn zero_byte_file_is_included_and_not_binary() {
        let scratch = ScratchDir::new("zero-byte-file");
        let root = scratch.path();
        fs::write(root.join("empty.txt"), []).unwrap();

        let (entries, _) = discover_tree(root);
        let entry = entries
            .iter()
            .find(|e| e.path == "empty.txt")
            .expect("expected an entry for empty.txt");

        assert!(!entry.likely_secret);
    }

    /// Builds a buffer of `len` bytes, all `'a'`, with a single NUL byte at
    /// `nul_index`, for exercising the `BINARY_SNIFF_LEN` boundary.
    fn buffer_with_nul_at(len: usize, nul_index: usize) -> Vec<u8> {
        let mut buffer = vec![b'a'; len];
        buffer[nul_index] = 0;
        buffer
    }

    #[test]
    fn nul_just_before_sniff_window_is_detected_as_binary() {
        // 0-indexed byte 7998 (the 7999th byte) is inside the first
        // BINARY_SNIFF_LEN (8000) bytes read.
        let scratch = ScratchDir::new("nul-before-window");
        let root = scratch.path();
        fs::write(
            root.join("almost-binary.dat"),
            buffer_with_nul_at(8000, 7998),
        )
        .unwrap();

        let (entries, _) = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(!paths.contains(&"almost-binary.dat"));
    }

    #[test]
    fn nul_exactly_at_sniff_window_edge_is_detected_as_binary() {
        // 0-indexed byte 7999 (the 8000th byte) is the last byte read by
        // `take(BINARY_SNIFF_LEN)`.
        let scratch = ScratchDir::new("nul-at-window-edge");
        let root = scratch.path();
        fs::write(root.join("edge-binary.dat"), buffer_with_nul_at(8000, 7999)).unwrap();

        let (entries, _) = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(!paths.contains(&"edge-binary.dat"));
    }

    #[test]
    fn nul_just_after_sniff_window_is_not_detected_as_binary() {
        // 0-indexed byte 8000 (the 8001st byte) falls just outside the
        // range read by `take(BINARY_SNIFF_LEN)`, so it is not seen.
        let scratch = ScratchDir::new("nul-after-window");
        let root = scratch.path();
        fs::write(root.join("not-binary.dat"), buffer_with_nul_at(8001, 8000)).unwrap();

        let (entries, _) = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(paths.contains(&"not-binary.dat"));
    }

    #[cfg(unix)]
    #[test]
    fn skips_unreadable_file_without_failing_whole_walk() {
        use std::os::unix::fs::PermissionsExt;

        let scratch = ScratchDir::new("unreadable-file");
        let root = scratch.path();
        fs::write(root.join("visible.txt"), "visible").unwrap();
        let blocked = root.join("blocked.txt");
        fs::write(&blocked, "blocked").unwrap();
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o000)).unwrap();

        // Some CI environments run as root (or otherwise don't enforce
        // permission bits), in which case the chmod above has no real
        // effect. Confirm the file is actually unreadable before asserting
        // on it; otherwise skip rather than assert a false failure.
        if fs::File::open(&blocked).is_ok() {
            fs::set_permissions(&blocked, fs::Permissions::from_mode(0o644)).unwrap();
            return;
        }

        let (entries, _) = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(paths.contains(&"visible.txt"));
        assert!(!paths.contains(&"blocked.txt"));

        // Restore permissions so ScratchDir's Drop can remove the directory.
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o644)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn skips_unreadable_subdirectory_but_continues_walk() {
        use std::os::unix::fs::PermissionsExt;

        let scratch = ScratchDir::new("unreadable-subdir");
        let root = scratch.path();
        fs::write(root.join("before.txt"), "before").unwrap();
        let blocked_dir = root.join("blocked_dir");
        fs::create_dir(&blocked_dir).unwrap();
        fs::write(blocked_dir.join("hidden.txt"), "hidden").unwrap();
        fs::write(root.join("after.txt"), "after").unwrap();
        fs::set_permissions(&blocked_dir, fs::Permissions::from_mode(0o000)).unwrap();

        // Same root-vs-CI caveat as skips_unreadable_file_without_failing_whole_walk.
        if fs::read_dir(&blocked_dir).is_ok() {
            fs::set_permissions(&blocked_dir, fs::Permissions::from_mode(0o755)).unwrap();
            return;
        }

        let (entries, _) = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(paths.contains(&"before.txt"));
        assert!(paths.contains(&"after.txt"));
        assert!(!paths.contains(&"blocked_dir/hidden.txt"));

        // Restore permissions so ScratchDir's Drop can remove the directory.
        fs::set_permissions(&blocked_dir, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn does_not_hang_on_a_fifo_with_no_writer() {
        // Opening a FIFO (named pipe) for reading blocks until a writer
        // opens the other end. If `discover_tree` ever reached
        // `is_probably_binary` -> `File::open` for a FIFO, a request against
        // a directory containing one would hang forever. Run the walk on a
        // background thread and require it to finish within a short
        // deadline, so a regression fails this test instead of hanging the
        // whole test binary.
        use std::sync::mpsc;
        use std::time::Duration;

        let scratch = ScratchDir::new("fifo");
        let root = scratch.path().to_path_buf();
        fs::write(root.join("kept.txt"), "kept").unwrap();

        let fifo_path = root.join("a.fifo");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo_path)
            .status()
            .expect("the `mkfifo` command should be available on this system");
        assert!(status.success(), "mkfifo should succeed");

        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let (entries, _) = discover_tree(&root);
            // If the receiver already gave up (test failed/timed out),
            // there is nobody left to notice a send error.
            let _ = sender.send(entries);
        });

        let entries = receiver.recv_timeout(Duration::from_secs(5)).expect(
            "discover_tree should not hang when the root contains a FIFO \
             with no writer (opening it would block forever)",
        );
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(paths.contains(&"kept.txt"));
        assert!(
            !paths.contains(&"a.fifo"),
            "a FIFO should be skipped, not included in the tree: {paths:?}"
        );
    }

    #[test]
    fn is_probably_binary_returns_err_for_missing_path() {
        let scratch = ScratchDir::new("missing-path");
        let missing = scratch.path().join("does-not-exist.txt");

        let result = is_probably_binary(&missing);

        assert!(
            result.is_err(),
            "expected an Err for a missing path, got: {result:?}"
        );
    }

    #[test]
    fn root_named_like_baseline_excluded_dir_is_still_served() {
        let scratch = ScratchDir::new("root-baseline-name");
        // The root itself is named like a baseline-excluded directory; the
        // baseline filter only applies at depth > 0, so the root's own
        // contents must still be served normally.
        let root = scratch.path().join("node_modules");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("kept.txt"), "kept").unwrap();

        let (entries, _) = discover_tree(&root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert_eq!(paths, vec!["kept.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_double_symlink_indirection() {
        let scratch = ScratchDir::new("double-symlink-root");
        let outside = ScratchDir::new("double-symlink-outside");
        fs::write(outside.path().join("secret.txt"), "outside root").unwrap();

        let root = scratch.path();
        fs::write(root.join("kept.txt"), "kept").unwrap();
        // A symlink chain: hop1 -> hop2 -> outside directory.
        std::os::unix::fs::symlink(outside.path(), root.join("hop2")).unwrap();
        std::os::unix::fs::symlink(root.join("hop2"), root.join("hop1")).unwrap();

        let (entries, _) = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert_eq!(paths, vec!["kept.txt"]);
    }

    #[test]
    fn discovers_files_with_non_ascii_and_special_characters() {
        let scratch = ScratchDir::new("non-ascii-files");
        let root = scratch.path();
        fs::write(root.join("日本語.txt"), "japanese name").unwrap();
        fs::write(root.join("😀ファイル.md"), "emoji name").unwrap();

        let (entries, _) = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(paths.contains(&"日本語.txt"));
        assert!(paths.contains(&"😀ファイル.md"));
    }

    #[test]
    fn gitignored_secret_file_never_appears_regardless_of_secret_flag() {
        let scratch = ScratchDir::new("gitignored-secret");
        let root = scratch.path();
        fs::write(root.join(".gitignore"), ".env\n").unwrap();
        fs::write(root.join(".env"), "SECRET=1").unwrap();

        let (entries, _) = discover_tree(root);

        assert!(
            entries.iter().all(|e| e.path != ".env"),
            ".env excluded by .gitignore should never appear in the tree, even flagged: {entries:?}"
        );
    }

    // ---- resolve_regular_file ----

    #[test]
    fn resolve_regular_file_accepts_a_plain_relative_path() {
        let scratch = ScratchDir::new("resolve-plain");
        fs::write(scratch.path().join("a.txt"), "hello").unwrap();

        let resolved = resolve_regular_file(scratch.path(), "a.txt");
        assert_eq!(resolved, Ok(scratch.path().join("a.txt")));
    }

    #[test]
    fn resolve_regular_file_accepts_a_nested_relative_path() {
        let scratch = ScratchDir::new("resolve-nested");
        fs::create_dir_all(scratch.path().join("sub/dir")).unwrap();
        fs::write(scratch.path().join("sub/dir/a.txt"), "hello").unwrap();

        let resolved = resolve_regular_file(scratch.path(), "sub/dir/a.txt");
        assert_eq!(resolved, Ok(scratch.path().join("sub/dir/a.txt")));
    }

    #[test]
    fn resolve_regular_file_rejects_parent_dir_traversal() {
        let scratch = ScratchDir::new("resolve-traversal");
        assert_eq!(
            resolve_regular_file(scratch.path(), "../secret.txt"),
            Err(ResolveError::Invalid)
        );
    }

    #[test]
    fn resolve_regular_file_rejects_an_absolute_path() {
        let scratch = ScratchDir::new("resolve-absolute");
        fs::write(scratch.path().join("a.txt"), "hello").unwrap();
        assert_eq!(
            resolve_regular_file(scratch.path(), "/etc/passwd"),
            Err(ResolveError::Invalid)
        );
    }

    #[test]
    fn resolve_regular_file_rejects_a_directory() {
        let scratch = ScratchDir::new("resolve-dir");
        fs::create_dir(scratch.path().join("sub")).unwrap();
        assert_eq!(
            resolve_regular_file(scratch.path(), "sub"),
            Err(ResolveError::Invalid)
        );
    }

    #[test]
    fn resolve_regular_file_rejects_a_missing_path() {
        let scratch = ScratchDir::new("resolve-missing");
        assert_eq!(
            resolve_regular_file(scratch.path(), "nope.txt"),
            Err(ResolveError::Invalid)
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_regular_file_rejects_a_symlinked_file() {
        let scratch = ScratchDir::new("resolve-symlink-file");
        fs::write(scratch.path().join("real.txt"), "hello").unwrap();
        std::os::unix::fs::symlink(
            scratch.path().join("real.txt"),
            scratch.path().join("link.txt"),
        )
        .unwrap();

        assert_eq!(
            resolve_regular_file(scratch.path(), "link.txt"),
            Err(ResolveError::Invalid)
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_regular_file_rejects_a_path_through_a_symlinked_intermediate_directory() {
        let scratch = ScratchDir::new("resolve-symlink-dir");
        fs::create_dir(scratch.path().join("real-dir")).unwrap();
        fs::write(scratch.path().join("real-dir/a.txt"), "hello").unwrap();
        std::os::unix::fs::symlink(
            scratch.path().join("real-dir"),
            scratch.path().join("link-dir"),
        )
        .unwrap();

        assert_eq!(
            resolve_regular_file(scratch.path(), "link-dir/a.txt"),
            Err(ResolveError::Invalid)
        );
    }

    #[test]
    fn resolve_regular_file_accepts_a_file_exactly_at_the_size_cap() {
        let scratch = ScratchDir::new("resolve-size-exact");
        let path = scratch.path().join("exact.bin");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_SERVABLE_FILE_SIZE).unwrap();

        assert_eq!(resolve_regular_file(scratch.path(), "exact.bin"), Ok(path));
    }

    #[test]
    fn resolve_regular_file_rejects_a_file_over_the_size_cap() {
        let scratch = ScratchDir::new("resolve-size-over");
        let path = scratch.path().join("big.bin");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_SERVABLE_FILE_SIZE + 1).unwrap();

        assert_eq!(
            resolve_regular_file(scratch.path(), "big.bin"),
            Err(ResolveError::TooLarge)
        );
    }

    // ---- discover_tree pathological-tree cap ----

    #[test]
    fn discover_tree_with_limit_caps_the_number_of_entries_collected() {
        let scratch = ScratchDir::new("tree-cap");
        for i in 0..10 {
            fs::write(scratch.path().join(format!("f{i}.txt")), "x").unwrap();
        }

        // The walk visits the root directory itself first (depth 0, always
        // filtered out, never collected) before any child, so it costs one
        // slot of the budget too: max_entries=4 here is "room for the root
        // plus 3 files", not "room for 3 files".
        let (entries, truncated) = discover_tree_with_limit(scratch.path(), 4);
        assert_eq!(entries.len(), 3);
        assert!(truncated);
    }

    #[test]
    fn discover_tree_with_limit_returns_every_entry_when_under_the_cap() {
        let scratch = ScratchDir::new("tree-under-cap");
        fs::write(scratch.path().join("a.txt"), "a").unwrap();
        fs::write(scratch.path().join("b.txt"), "b").unwrap();

        let (entries, truncated) = discover_tree_with_limit(scratch.path(), 1000);
        assert_eq!(entries.len(), 2);
        assert!(!truncated);
    }

    #[cfg(unix)]
    #[test]
    fn discover_tree_with_limit_counts_filtered_out_entries_against_the_cap_too() {
        // Regression guard: the cap used to only bound how many entries got
        // *collected*, so a tree dominated by filtered-out items (symlinks,
        // binaries, ...) could blow straight through it while still opening
        // and reading every single one of them via `is_probably_binary`.
        let scratch = ScratchDir::new("tree-cap-filtered");
        let root = scratch.path();
        fs::write(root.join("real.txt"), "kept").unwrap();
        for i in 0..5 {
            std::os::unix::fs::symlink(root.join("real.txt"), root.join(format!("a_link{i}")))
                .unwrap();
        }

        // File-name-sorted walk order puts "a_link0".."a_link4" (all
        // filtered out as symlinks) before "real.txt". A cap that only
        // counted collected entries would skip past all 5 symlinks for free
        // and still reach "real.txt"; counting every visited item means the
        // symlinks alone can exhaust a small budget first.
        let (entries, truncated) = discover_tree_with_limit(root, 3);
        assert!(
            entries.is_empty(),
            "real.txt should not have been reached: {entries:?}"
        );
        assert!(truncated);
    }
}
