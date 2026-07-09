//! Safe file discovery for the selected root directory.
//!
//! Walks the root with the `ignore` crate, respects `.gitignore`, and applies
//! a small set of baseline safety rules on top of it: `.git` and common
//! dependency/build directories are always excluded even without a
//! `.gitignore`, symlinks are never followed (so a symlink cannot be used to
//! read or list anything outside the selected root), and files that look
//! like secrets (`.env`, private keys, credential files, ...) are flagged
//! rather than silently hidden.
//!
//! See README.md for the user-facing description of these rules and their
//! known limitations.

use ignore::WalkBuilder;
use serde::Serialize;
use std::io::Read;
use std::path::Path;

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
/// - Files that look binary (a NUL byte in the first [`BINARY_SNIFF_LEN`]
///   bytes) or that cannot be read (e.g. a permission error): these are
///   skipped rather than causing the whole walk to fail.
///
/// `root` itself is not included as an entry; only its contents are.
pub fn discover_tree(root: &Path) -> Vec<FileEntry> {
    let mut entries = Vec::new();

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

    for result in walker {
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
    entries
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

/// Reads up to [`BINARY_SNIFF_LEN`] bytes of `path` and returns whether a
/// NUL byte appears in that prefix. Read failures (e.g. permission denied)
/// are surfaced as `Err` so the caller can skip the entry instead of
/// panicking.
fn is_probably_binary(path: &Path) -> std::io::Result<bool> {
    let file = std::fs::File::open(path)?;
    let mut buffer = Vec::with_capacity(BINARY_SNIFF_LEN);
    file.take(BINARY_SNIFF_LEN as u64)
        .read_to_end(&mut buffer)?;
    Ok(buffer.contains(&0))
}

/// Baseline, non-exhaustive check for file names that commonly hold
/// secrets. Matching files are flagged via `likely_secret`, not excluded;
/// hardening this list further is out of scope here (see issue #9).
fn looks_like_secret(path: &Path) -> bool {
    let Some(file_name) = path.file_name().map(|name| name.to_string_lossy()) else {
        return false;
    };

    if file_name == ".env" || file_name.starts_with(".env.") {
        return true;
    }

    if LIKELY_SECRET_EXACT_NAMES.contains(&file_name.as_ref()) {
        return true;
    }

    if let Some(extension) = path.extension().map(|ext| ext.to_string_lossy()) {
        if LIKELY_SECRET_EXTENSIONS.contains(&extension.to_lowercase().as_str()) {
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

        let entries = discover_tree(root);
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

        let entries = discover_tree(root);
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

        let entries = discover_tree(root);
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

        let entries = discover_tree(root);
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

        let entries = discover_tree(root);
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

        let entries = discover_tree(root);
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

        let entries = discover_tree(root);
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

        let entries = discover_tree(root);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(paths.contains(&"real.txt"));
        assert!(!paths.contains(&"link.txt"));
    }
}
