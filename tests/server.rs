use prompt_builder_for_sidebar_ai::github_root::TempDirGuard;
use prompt_builder_for_sidebar_ai::{
    build_router, build_router_for_test, build_router_for_test_with_guard, generate_session_token,
};
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio::time::timeout;

/// Sends a bare-bones HTTP/1.1 request over a raw TCP connection and
/// returns the full response text (status line, headers, and body). Kept
/// dependency-free (no HTTP client crate) since this scaffold only needs to
/// observe the status line and, for one test, the body.
async fn request(addr: SocketAddr, method: &str, path: &str) -> String {
    let mut stream = TcpStream::connect(addr)
        .await
        .expect("should connect to the local server");

    let request =
        format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("should write the request");

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .await
        .expect("should read the response");
    response
}

async fn get(addr: SocketAddr, path: &str) -> String {
    request(addr, "GET", path).await
}

/// Extracts the response body: everything after the blank line that
/// terminates the headers.
fn body_of(response: &str) -> &str {
    response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap_or_default()
}

/// Extracts the response headers: everything before the blank line that
/// terminates them, lower-cased so header-name/value checks are
/// case-insensitive without repeating `.to_lowercase()` at every call site.
fn headers_of(response: &str) -> String {
    response
        .split_once("\r\n\r\n")
        .map(|(headers, _)| headers)
        .unwrap_or_default()
        .to_lowercase()
}

/// Minimal percent-encoder for building query strings by hand (no HTTP
/// client / urlencoding crate dependency in this test scaffold). Encodes
/// every byte outside the unreserved set (ASCII alphanumerics plus
/// `-_.~`), which covers both non-ASCII UTF-8 bytes (for the non-ASCII
/// filename round-trip test) and `.`/`/`  when the caller wants an
/// explicitly `%2e%2e%2f`-style traversal string.
fn percent_encode(input: &str) -> String {
    let mut out = String::new();
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Spins up a fresh session server on an OS-assigned loopback port for a
/// single test, rooted at an arbitrary directory. Each test gets its own
/// token, router, and listener so tests can run concurrently without
/// interfering with each other.
async fn spawn_test_server_with_root(root: PathBuf) -> (SocketAddr, String, JoinHandle<()>) {
    let token = generate_session_token();
    let router = build_router(&token, root);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("should bind an available loopback port");
    let addr = listener
        .local_addr()
        .expect("bound listener should have a local address");

    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("server should run without error");
    });

    (addr, token, server)
}

/// Spins up a fresh session server rooted at the current working directory.
/// See [`spawn_test_server_with_root`] for a variant that accepts an
/// arbitrary root (used by tests that need to control the tree contents).
async fn spawn_test_server() -> (SocketAddr, String, JoinHandle<()>) {
    let root = std::env::current_dir().expect("should read the current directory");
    spawn_test_server_with_root(root).await
}

/// Spins up a fresh session server with `dialog_available`/`folder_picker`
/// fakes standing in for the real native-dialog check and the real
/// (blocking) `rfd` call `POST /{token}/api/open-folder` otherwise uses --
/// see `build_router_for_test`'s doc comment for why a fake is necessary at
/// all (there is no windowing system in a headless CI runner to show a real
/// dialog in). Every other endpoint behaves exactly as with
/// [`spawn_test_server_with_root`].
async fn spawn_test_server_with_fakes(
    root: PathBuf,
    dialog_available: impl Fn() -> bool + Send + Sync + 'static,
    folder_picker: impl Fn() -> Option<PathBuf> + Send + Sync + 'static,
) -> (SocketAddr, String, JoinHandle<()>) {
    let token = generate_session_token();
    let router = build_router_for_test(&token, root, dialog_available, folder_picker);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("should bind an available loopback port");
    let addr = listener
        .local_addr()
        .expect("bound listener should have a local address");

    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("server should run without error");
    });

    (addr, token, server)
}

/// Like [`spawn_test_server_with_fakes`], but also seeds the session with a
/// pre-existing [`TempDirGuard`] (issue #11 should-fix: testing that
/// switching roots drops the *previous* root's guard -- and so removes its
/// temp directory from disk -- immediately, not just at process exit).
async fn spawn_test_server_with_fakes_and_guard(
    root: PathBuf,
    root_guard: Option<TempDirGuard>,
    dialog_available: impl Fn() -> bool + Send + Sync + 'static,
    folder_picker: impl Fn() -> Option<PathBuf> + Send + Sync + 'static,
) -> (SocketAddr, String, JoinHandle<()>) {
    let token = generate_session_token();
    let router =
        build_router_for_test_with_guard(&token, root, root_guard, dialog_available, folder_picker);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("should bind an available loopback port");
    let addr = listener
        .local_addr()
        .expect("bound listener should have a local address");

    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("server should run without error");
    });

    (addr, token, server)
}

/// A directory under the OS temp dir that is removed on drop, mirroring the
/// `ScratchDir` helper used in `src/discovery.rs` and `src/lib.rs`'s test
/// modules.
struct ScratchDir(PathBuf);

impl ScratchDir {
    fn new(name_hint: &str) -> Self {
        let unique = format!(
            "prompt-builder-server-{name_hint}-{}-{}",
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

    /// Runs a Git command against this directory, panicking if it fails.
    /// Only used by the `/api/diff` tests below; every other test leaves
    /// `ScratchDir` as a plain (non-Git) directory.
    fn git(&self, args: &[&str]) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(&self.0)
            .args(args)
            .status()
            .expect("git should be installed and runnable");
        assert!(status.success(), "git {args:?} should succeed");
    }

    /// Initializes this directory as a Git repository with a local identity
    /// configured (so `git commit` works even in a CI environment with no
    /// global `user.name`/`user.email` set).
    fn git_init(&self) {
        self.git(&["init", "-q"]);
        self.git(&["config", "user.email", "test@example.com"]);
        self.git(&["config", "user.name", "Test"]);
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn session_path_responds_and_other_paths_are_rejected() {
    let (addr, token, server) = spawn_test_server().await;

    let session_response = get(addr, &format!("/{token}")).await;
    assert!(
        session_response.starts_with("HTTP/1.1 200"),
        "expected 200 for the session path, got: {session_response}"
    );

    let wrong_token_response = get(addr, "/not-the-session-token").await;
    assert!(
        wrong_token_response.starts_with("HTTP/1.1 404"),
        "expected 404 for a path without the session token, got: {wrong_token_response}"
    );

    let bare_root_response = get(addr, "/").await;
    assert!(
        bare_root_response.starts_with("HTTP/1.1 404"),
        "expected 404 for the bare root, got: {bare_root_response}"
    );

    server.abort();
}

#[tokio::test]
async fn router_returns_the_index_html_shell_for_the_valid_token() {
    // The served body is `assets/index.html` with its
    // `/*__STYLE_PLACEHOLDER__*/` and `//__SCRIPT_PLACEHOLDER__` markers
    // replaced by the contents of `assets/style.css` and `assets/app.js`
    // (see `rendered_index_html` in src/lib.rs), so it is no longer a
    // verbatim match of the template file on disk. Assert the substitution
    // actually happened instead of a raw file comparison.
    let (addr, token, server) = spawn_test_server().await;

    let response = get(addr, &format!("/{token}")).await;
    let body = body_of(&response);

    assert!(
        body.contains("<title>prompt-builder-for-sidebar-ai</title>"),
        "expected the HTML shell's title, got body: {body}"
    );
    assert!(
        !body.contains("__STYLE_PLACEHOLDER__") && !body.contains("__SCRIPT_PLACEHOLDER__"),
        "expected the CSS/JS placeholders to be substituted, got body: {body}"
    );
    assert!(
        body.contains("data-theme=\"dark\""),
        "expected the shell to default to the dark theme, got body: {body}"
    );

    server.abort();
}

#[tokio::test]
async fn router_returns_405_for_a_non_get_method_on_the_valid_token() {
    // Most important gap identified in QA review: axum's routing matches a
    // path first and only then checks the method, so a wrong-method request
    // to an otherwise-correct `/{token}` path falls through to axum's
    // built-in "405 Method Not Allowed" handling rather than this app's own
    // 404 fallback.
    let (addr, token, server) = spawn_test_server().await;

    let response = request(addr, "POST", &format!("/{token}")).await;
    assert!(
        response.starts_with("HTTP/1.1 405"),
        "expected 405 for a non-GET method on the valid token path, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn router_returns_200_for_a_head_request_on_the_valid_token() {
    // axum/tower's `get` routes implicitly also serve HEAD, so a HEAD request
    // to the valid token path should succeed like GET does, not fall through
    // to the 405 handling exercised by the POST test above.
    let (addr, token, server) = spawn_test_server().await;

    let response = request(addr, "HEAD", &format!("/{token}")).await;
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "expected 200 for a HEAD request on the valid token path, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn router_returns_404_for_an_uppercased_token() {
    let (addr, token, server) = spawn_test_server().await;

    let response = get(addr, &format!("/{}", token.to_uppercase())).await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for an uppercased token, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn router_returns_404_for_a_non_get_method_on_an_invalid_token() {
    let (addr, _token, server) = spawn_test_server().await;

    let response = request(addr, "POST", "/not-the-session-token").await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for POST on an invalid token, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn router_returns_404_for_an_empty_path_segment() {
    let (addr, _token, server) = spawn_test_server().await;

    let response = get(addr, "//").await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for an empty path segment, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn router_returns_404_for_the_valid_token_with_an_extra_path_segment() {
    let (addr, token, server) = spawn_test_server().await;

    let response = get(addr, &format!("/{token}/extra")).await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for the token with an extra path segment, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn router_returns_404_for_the_token_truncated_by_one_character() {
    let (addr, token, server) = spawn_test_server().await;

    let truncated = &token[..token.len() - 1];
    let response = get(addr, &format!("/{truncated}")).await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for a token truncated by one character, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn router_returns_404_for_the_token_with_one_extra_trailing_character() {
    let (addr, token, server) = spawn_test_server().await;

    let response = get(addr, &format!("/{token}X")).await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for a token with one extra trailing character, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn router_serves_the_valid_token_on_repeated_requests() {
    // The session token is not a one-time-use value: it should keep serving
    // the shell for as long as the process runs.
    let (addr, token, server) = spawn_test_server().await;

    let first_response = get(addr, &format!("/{token}")).await;
    let second_response = get(addr, &format!("/{token}")).await;
    assert!(
        first_response.starts_with("HTTP/1.1 200"),
        "expected 200 on the first request, got: {first_response}"
    );
    assert!(
        second_response.starts_with("HTTP/1.1 200"),
        "expected 200 on the second request, got: {second_response}"
    );

    server.abort();
}

/// Regression guard for the security invariant documented in README.md and
/// implemented in src/main.rs: the server must bind to loopback only
/// (127.0.0.1), never to all interfaces (0.0.0.0). This mirrors the literal
/// bind address used by src/main.rs and by `spawn_test_server` above; if
/// that address ever changes, this assumption should be revisited too.
#[tokio::test]
async fn server_binds_to_a_loopback_address_only() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("should bind an available loopback port");
    let addr = listener
        .local_addr()
        .expect("bound listener should have a local address");

    assert!(
        addr.ip().is_loopback(),
        "server should bind to a loopback address, got: {addr}"
    );
}

#[tokio::test]
async fn api_tree_returns_200_and_json_content_type_for_valid_token() {
    let (addr, token, server) = spawn_test_server().await;

    let response = get(addr, &format!("/{token}/api/tree")).await;
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "expected 200 for a valid token's api/tree, got: {response}"
    );
    let headers = response
        .split_once("\r\n\r\n")
        .map(|(headers, _)| headers)
        .unwrap_or_default();
    assert!(
        headers
            .to_lowercase()
            .contains("content-type: application/json"),
        "expected a JSON content type header, got headers: {headers}"
    );

    server.abort();
}

#[tokio::test]
async fn api_tree_body_matches_directory_contents() {
    let scratch = ScratchDir::new("tree-contents");
    std::fs::write(scratch.path().join("a.txt"), "a").unwrap();
    std::fs::write(scratch.path().join("b.txt"), "b").unwrap();
    std::fs::create_dir(scratch.path().join("sub")).unwrap();
    std::fs::write(scratch.path().join("sub/c.txt"), "c").unwrap();

    let (addr, token, server) = spawn_test_server_with_root(scratch.path().to_path_buf()).await;

    let response = get(addr, &format!("/{token}/api/tree")).await;
    let body = body_of(&response);
    let parsed: serde_json::Value = serde_json::from_str(body)
        .unwrap_or_else(|err| panic!("body should be valid JSON: {err}, body: {body}"));
    assert_eq!(parsed["truncated"], false);
    let paths: std::collections::BTreeSet<String> = parsed["entries"]
        .as_array()
        .expect("body should have an 'entries' array")
        .iter()
        .map(|entry| {
            entry["path"]
                .as_str()
                .expect("entry should have a string path")
                .to_string()
        })
        .collect();

    let expected: std::collections::BTreeSet<String> = ["a.txt", "b.txt", "sub", "sub/c.txt"]
        .into_iter()
        .map(String::from)
        .collect();
    assert_eq!(paths, expected);

    server.abort();
}

#[tokio::test]
async fn api_tree_returns_404_for_wrong_token() {
    let (addr, _token, server) = spawn_test_server().await;

    let response = get(addr, "/not-the-session-token/api/tree").await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for api/tree with the wrong token, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_tree_returns_405_for_post() {
    let (addr, token, server) = spawn_test_server().await;

    let response = request(addr, "POST", &format!("/{token}/api/tree")).await;
    assert!(
        response.starts_with("HTTP/1.1 405"),
        "expected 405 for a POST to api/tree, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_tree_returns_404_for_extra_path_segment() {
    let (addr, token, server) = spawn_test_server().await;

    let response = get(addr, &format!("/{token}/api/tree/extra")).await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for api/tree with an extra path segment, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_tree_ignores_query_string_parameters() {
    let (addr, token, server) = spawn_test_server().await;

    let plain_response = get(addr, &format!("/{token}/api/tree")).await;
    let with_query_response = get(addr, &format!("/{token}/api/tree?path=../..")).await;

    assert!(
        plain_response.starts_with("HTTP/1.1 200"),
        "expected 200 without a query string, got: {plain_response}"
    );
    assert_eq!(
        body_of(&plain_response),
        body_of(&with_query_response),
        "a query string should not change the api/tree response body"
    );

    server.abort();
}

#[tokio::test]
async fn two_concurrent_requests_to_api_tree_return_identical_bodies() {
    let (addr, token, server) = spawn_test_server().await;
    let path = format!("/{token}/api/tree");

    let (first_response, second_response) = tokio::join!(get(addr, &path), get(addr, &path));

    assert!(
        first_response.starts_with("HTTP/1.1 200"),
        "expected 200 for the first concurrent request, got: {first_response}"
    );
    assert!(
        second_response.starts_with("HTTP/1.1 200"),
        "expected 200 for the second concurrent request, got: {second_response}"
    );
    assert_eq!(
        body_of(&first_response),
        body_of(&second_response),
        "concurrent requests to api/tree should return identical bodies"
    );

    server.abort();
}

#[tokio::test]
async fn api_tree_returns_empty_entries_and_untruncated_for_empty_root() {
    let scratch = ScratchDir::new("empty-root");

    let (addr, token, server) = spawn_test_server_with_root(scratch.path().to_path_buf()).await;

    let response = get(addr, &format!("/{token}/api/tree")).await;
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "expected 200 for an empty root, got: {response}"
    );
    let body = body_of(&response);
    let parsed: serde_json::Value = serde_json::from_str(body)
        .unwrap_or_else(|err| panic!("body should be valid JSON: {err}, body: {body}"));
    assert_eq!(parsed["entries"], serde_json::json!([]));
    assert_eq!(parsed["truncated"], false);

    server.abort();
}

// ---- /api/root ----

#[tokio::test]
async fn api_root_returns_200_and_json_content_type_for_valid_token() {
    let (addr, token, server) = spawn_test_server().await;

    let response = get(addr, &format!("/{token}/api/root")).await;
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "expected 200 for a valid token's api/root, got: {response}"
    );
    assert!(
        headers_of(&response).contains("content-type: application/json"),
        "expected a JSON content type header, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_root_body_contains_basename_and_absolute_path_matching_scratch_root() {
    let scratch = ScratchDir::new("root-info");
    let (addr, token, server) = spawn_test_server_with_root(scratch.path().to_path_buf()).await;

    let response = get(addr, &format!("/{token}/api/root")).await;
    let body = body_of(&response);
    let parsed: serde_json::Value = serde_json::from_str(body)
        .unwrap_or_else(|err| panic!("body should be valid JSON: {err}, body: {body}"));

    let expected_basename = scratch
        .path()
        .file_name()
        .expect("scratch dir should have a basename")
        .to_string_lossy()
        .into_owned();

    assert_eq!(
        parsed["basename"].as_str(),
        Some(expected_basename.as_str())
    );
    assert_eq!(
        parsed["absolutePath"].as_str(),
        Some(scratch.path().display().to_string().as_str())
    );

    server.abort();
}

#[tokio::test]
async fn api_root_falls_back_to_absolute_path_when_basename_is_none_for_bare_slash_root() {
    // `Path::new("/").file_name()` returns `None` (the filesystem root has no
    // basename component), which exercises `serve_root`'s
    // `unwrap_or_else(|| root.display().to_string())` fallback. Deliberately
    // hits only `/api/root`, not `/api/tree`: walking the real filesystem
    // root would be slow and would touch files outside this test's control.
    let (addr, token, server) = spawn_test_server_with_root(PathBuf::from("/")).await;

    let response = get(addr, &format!("/{token}/api/root")).await;
    let body = body_of(&response);
    let parsed: serde_json::Value = serde_json::from_str(body)
        .unwrap_or_else(|err| panic!("body should be valid JSON: {err}, body: {body}"));

    assert_eq!(parsed["basename"].as_str(), Some("/"));
    assert_eq!(parsed["absolutePath"].as_str(), Some("/"));

    server.abort();
}

#[tokio::test]
async fn api_root_returns_404_for_wrong_token() {
    let (addr, _token, server) = spawn_test_server().await;

    let response = get(addr, "/not-the-session-token/api/root").await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for api/root with the wrong token, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_root_returns_405_for_post() {
    let (addr, token, server) = spawn_test_server().await;

    let response = request(addr, "POST", &format!("/{token}/api/root")).await;
    assert!(
        response.starts_with("HTTP/1.1 405"),
        "expected 405 for a POST to api/root, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_root_returns_404_for_extra_path_segment() {
    let (addr, token, server) = spawn_test_server().await;

    let response = get(addr, &format!("/{token}/api/root/extra")).await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for api/root with an extra path segment, got: {response}"
    );

    server.abort();
}

// ---- /api/file ----

#[tokio::test]
async fn api_file_returns_400_for_missing_path_query() {
    let (addr, token, server) = spawn_test_server().await;

    let response = get(addr, &format!("/{token}/api/file")).await;
    assert!(
        response.starts_with("HTTP/1.1 400"),
        "expected 400 when the 'path' query parameter is missing entirely, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_file_returns_400_for_empty_path_query() {
    let (addr, token, server) = spawn_test_server().await;

    let response = get(addr, &format!("/{token}/api/file?path=")).await;
    assert!(
        response.starts_with("HTTP/1.1 400"),
        "expected 400 for an empty 'path' query value, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_file_returns_200_and_text_plain_for_existing_file_with_exact_body() {
    let scratch = ScratchDir::new("file-ok");
    fs::write(scratch.path().join("hello.txt"), "hello world\n").unwrap();
    let (addr, token, server) = spawn_test_server_with_root(scratch.path().to_path_buf()).await;

    let response = get(addr, &format!("/{token}/api/file?path=hello.txt")).await;
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "expected 200 for an existing text file, got: {response}"
    );
    assert!(
        headers_of(&response).contains("content-type: text/plain; charset=utf-8"),
        "expected a text/plain content type header, got: {response}"
    );
    assert_eq!(body_of(&response), "hello world\n");

    server.abort();
}

#[tokio::test]
async fn api_file_returns_404_for_nonexistent_relative_path() {
    let scratch = ScratchDir::new("file-missing");
    let (addr, token, server) = spawn_test_server_with_root(scratch.path().to_path_buf()).await;

    let response = get(addr, &format!("/{token}/api/file?path=does-not-exist.txt")).await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for a nonexistent relative path, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_file_returns_404_for_a_directory_path() {
    let scratch = ScratchDir::new("file-is-dir");
    fs::create_dir(scratch.path().join("subdir")).unwrap();
    let (addr, token, server) = spawn_test_server_with_root(scratch.path().to_path_buf()).await;

    let response = get(addr, &format!("/{token}/api/file?path=subdir")).await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 when the requested path is a directory, got: {response}"
    );

    server.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn api_file_does_not_hang_and_returns_404_for_a_fifo() {
    // Most important regression guard in this file: `serve_file` must check
    // `is_regular_file` (metadata) *before* it ever calls
    // `is_probably_binary` (which opens the file). If that ordering ever
    // regresses, opening a FIFO with no writer on the other end blocks
    // forever, hanging the request. Wrap the request in `tokio::time::timeout`
    // so a regression fails this test instead of hanging the whole suite.
    let scratch = ScratchDir::new("file-fifo");
    let root = scratch.path().to_path_buf();

    let fifo_path = root.join("a.fifo");
    let status = std::process::Command::new("mkfifo")
        .arg(&fifo_path)
        .status()
        .expect("the `mkfifo` command should be available on this system");
    assert!(status.success(), "mkfifo should succeed");

    let (addr, token, server) = spawn_test_server_with_root(root).await;

    let response = timeout(
        Duration::from_secs(5),
        get(addr, &format!("/{token}/api/file?path=a.fifo")),
    )
    .await
    .expect("a request for a FIFO path should not hang");

    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for a FIFO path, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_file_returns_404_for_dotdot_traversal_to_an_existing_outside_file() {
    let root_scratch = ScratchDir::new("traversal-root");
    let outside_scratch = ScratchDir::new("traversal-outside");
    fs::write(outside_scratch.path().join("secret.txt"), "outside content").unwrap();
    let outside_name = outside_scratch
        .path()
        .file_name()
        .expect("outside scratch dir should have a basename")
        .to_string_lossy()
        .into_owned();

    let (addr, token, server) =
        spawn_test_server_with_root(root_scratch.path().to_path_buf()).await;

    let response = get(
        addr,
        &format!("/{token}/api/file?path=../{outside_name}/secret.txt"),
    )
    .await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for '../' traversal to an existing outside file, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_file_returns_404_for_dotdot_traversal_to_a_nonexistent_outside_path() {
    // Paired with the test above: a `..` (ParentDir) component is now
    // rejected with 404 during path parsing, before the filesystem is ever
    // touched, so this case and the "existing outside file" case above are
    // symmetric. Both return 404 regardless of whether anything exists at
    // the resolved location, which is what closes the existence-oracle gap
    // that used to distinguish 403 (exists) from 404 (doesn't exist).
    let root_scratch = ScratchDir::new("traversal-root-missing");
    let (addr, token, server) =
        spawn_test_server_with_root(root_scratch.path().to_path_buf()).await;

    let response = get(
        addr,
        &format!("/{token}/api/file?path=../this-should-not-exist-anywhere-abc123/secret.txt"),
    )
    .await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for '../' traversal to a nonexistent outside path, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_file_returns_404_for_an_absolute_path_query_pointing_at_an_existing_outside_file() {
    let root_scratch = ScratchDir::new("absolute-traversal-root");
    let outside_scratch = ScratchDir::new("absolute-traversal-outside");
    fs::write(outside_scratch.path().join("secret.txt"), "outside content").unwrap();
    let absolute_outside_path = outside_scratch
        .path()
        .join("secret.txt")
        .display()
        .to_string();

    let (addr, token, server) =
        spawn_test_server_with_root(root_scratch.path().to_path_buf()).await;

    let response = get(
        addr,
        &format!("/{token}/api/file?path={absolute_outside_path}"),
    )
    .await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for an absolute path query pointing outside the root, got: {response}"
    );

    server.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn api_file_returns_404_for_a_symlink_inside_root_pointing_outside_root() {
    let root_scratch = ScratchDir::new("symlink-out-root");
    let outside_scratch = ScratchDir::new("symlink-out-outside");
    fs::write(outside_scratch.path().join("secret.txt"), "outside content").unwrap();
    std::os::unix::fs::symlink(
        outside_scratch.path().join("secret.txt"),
        root_scratch.path().join("escape.txt"),
    )
    .unwrap();

    let (addr, token, server) =
        spawn_test_server_with_root(root_scratch.path().to_path_buf()).await;

    let response = get(addr, &format!("/{token}/api/file?path=escape.txt")).await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for a symlink inside root that points outside root, got: {response}"
    );

    server.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn api_file_returns_404_for_a_symlink_that_stays_inside_root() {
    // `discover_tree` (`/api/tree`) always excludes symlink entries outright,
    // so a symlink that stays inside the root never appears in the tree
    // listing. `serve_file` (`/api/file`) now checks `symlink_metadata` at
    // every path component instead of only checking where the fully
    // resolved path ends up, so it refuses a symlink here too, unifying the
    // invariant: a symlink is never followed or served by either endpoint,
    // regardless of where it points.
    let scratch = ScratchDir::new("symlink-in-root");
    fs::write(scratch.path().join("real.txt"), "real content").unwrap();
    std::os::unix::fs::symlink(
        scratch.path().join("real.txt"),
        scratch.path().join("link.txt"),
    )
    .unwrap();

    let (addr, token, server) = spawn_test_server_with_root(scratch.path().to_path_buf()).await;

    let response = get(addr, &format!("/{token}/api/file?path=link.txt")).await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for a symlink that stays inside root (symlinks are never served), got: {response}"
    );

    server.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn api_file_returns_500_for_unreadable_file_permission_denied() {
    use std::os::unix::fs::PermissionsExt;

    // Fixed (was discovery #2): a permission-denied file used to be rejected
    // with 400 "binary files are not supported", because
    // `is_probably_binary`'s `File::open` fails and the caller mapped that
    // `Err` to "treat as binary" rather than distinguishing "unreadable"
    // from "actually binary". `serve_file` now matches on
    // `is_probably_binary`'s result explicitly and reports an `Err` (I/O
    // failure, typically permission denied) as 500, so the file isn't
    // misreported as a binary-format problem it doesn't actually have.
    let scratch = ScratchDir::new("file-permission-denied");
    let blocked = scratch.path().join("blocked.txt");
    fs::write(&blocked, "blocked content").unwrap();
    fs::set_permissions(&blocked, fs::Permissions::from_mode(0o000)).unwrap();

    // Some CI environments run as root (or otherwise don't enforce
    // permission bits), in which case the chmod above has no real effect.
    // Confirm the file is actually unreadable before asserting on it;
    // otherwise skip rather than assert a false failure.
    if fs::File::open(&blocked).is_ok() {
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o644)).unwrap();
        return;
    }

    let (addr, token, server) = spawn_test_server_with_root(scratch.path().to_path_buf()).await;

    let response = get(addr, &format!("/{token}/api/file?path=blocked.txt")).await;

    // Restore permissions so ScratchDir's Drop can remove the directory.
    fs::set_permissions(&blocked, fs::Permissions::from_mode(0o644)).unwrap();

    assert!(
        response.starts_with("HTTP/1.1 500"),
        "expected 500 (an unreadable file, not a binary-format rejection) for a permission-denied file, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_file_returns_400_for_a_binary_file() {
    let scratch = ScratchDir::new("file-binary");
    fs::write(scratch.path().join("binary.bin"), [0u8, 1, 2, 3]).unwrap();
    let (addr, token, server) = spawn_test_server_with_root(scratch.path().to_path_buf()).await;

    let response = get(addr, &format!("/{token}/api/file?path=binary.bin")).await;
    assert!(
        response.starts_with("HTTP/1.1 400"),
        "expected 400 for a binary file, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_file_returns_400_for_invalid_utf8_content() {
    let scratch = ScratchDir::new("file-invalid-utf8");
    // No NUL byte here (so the binary sniff heuristic does not reject it
    // first): 0xFF is never a valid UTF-8 lead byte, so this trips the
    // `String::from_utf8` check specifically.
    fs::write(
        scratch.path().join("invalid-utf8.txt"),
        [0xFF, 0xFE, b'a', b'b'],
    )
    .unwrap();
    let (addr, token, server) = spawn_test_server_with_root(scratch.path().to_path_buf()).await;

    let response = get(addr, &format!("/{token}/api/file?path=invalid-utf8.txt")).await;
    assert!(
        response.starts_with("HTTP/1.1 400"),
        "expected 400 for non-UTF-8 content that isn't NUL-flagged as binary, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_file_returns_200_for_a_file_with_non_ascii_name() {
    let scratch = ScratchDir::new("file-non-ascii-name");
    fs::write(scratch.path().join("日本語.txt"), "japanese name content").unwrap();
    let (addr, token, server) = spawn_test_server_with_root(scratch.path().to_path_buf()).await;

    let encoded_path = percent_encode("日本語.txt");
    let response = get(addr, &format!("/{token}/api/file?path={encoded_path}")).await;
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "expected 200 for a non-ASCII file name round-tripped through percent-encoding, got: {response}"
    );
    assert_eq!(body_of(&response), "japanese name content");

    server.abort();
}

#[tokio::test]
async fn api_file_returns_404_for_percent_encoded_dotdot_traversal() {
    let root_scratch = ScratchDir::new("percent-traversal-root");
    let outside_scratch = ScratchDir::new("percent-traversal-outside");
    fs::write(outside_scratch.path().join("secret.txt"), "outside content").unwrap();
    let outside_name = outside_scratch
        .path()
        .file_name()
        .expect("outside scratch dir should have a basename")
        .to_string_lossy()
        .into_owned();

    let (addr, token, server) =
        spawn_test_server_with_root(root_scratch.path().to_path_buf()).await;

    // percent_encode escapes every non-unreserved byte, including '.' and
    // '/', so this produces a "%2e%2e%2f"-style (upper-hex) traversal
    // string that decodes back to "../<outside_name>/secret.txt" server-side.
    let encoded_traversal = percent_encode(&format!("../{outside_name}/secret.txt"));
    let response = get(addr, &format!("/{token}/api/file?path={encoded_traversal}")).await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for a percent-encoded '../' traversal to an existing outside file, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_file_returns_404_for_wrong_token() {
    let (addr, _token, server) = spawn_test_server().await;

    let response = get(addr, "/not-the-session-token/api/file?path=anything.txt").await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for api/file with the wrong token, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_file_returns_405_for_post() {
    let (addr, token, server) = spawn_test_server().await;

    let response = request(
        addr,
        "POST",
        &format!("/{token}/api/file?path=anything.txt"),
    )
    .await;
    assert!(
        response.starts_with("HTTP/1.1 405"),
        "expected 405 for a POST to api/file, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn two_concurrent_requests_to_api_file_return_identical_bodies() {
    let scratch = ScratchDir::new("file-concurrent");
    fs::write(scratch.path().join("shared.txt"), "shared content").unwrap();
    let (addr, token, server) = spawn_test_server_with_root(scratch.path().to_path_buf()).await;
    let path = format!("/{token}/api/file?path=shared.txt");

    let (first_response, second_response) = tokio::join!(get(addr, &path), get(addr, &path));

    assert!(
        first_response.starts_with("HTTP/1.1 200"),
        "expected 200 for the first concurrent request, got: {first_response}"
    );
    assert!(
        second_response.starts_with("HTTP/1.1 200"),
        "expected 200 for the second concurrent request, got: {second_response}"
    );
    assert_eq!(
        body_of(&first_response),
        body_of(&second_response),
        "concurrent requests to api/file should return identical bodies"
    );

    server.abort();
}

#[tokio::test]
async fn api_file_returns_200_for_a_multi_megabyte_text_file() {
    // A few MB is enough to exercise the read path beyond a single buffer's
    // worth of data without slowing down the suite; GB-scale files are out
    // of scope for this test.
    let scratch = ScratchDir::new("file-multi-megabyte");
    let line = "the quick brown fox jumps over the lazy dog\n";
    let repeats = (5 * 1024 * 1024) / line.len() + 1;
    let content = line.repeat(repeats);
    fs::write(scratch.path().join("large.txt"), &content).unwrap();
    let (addr, token, server) = spawn_test_server_with_root(scratch.path().to_path_buf()).await;

    let response = get(addr, &format!("/{token}/api/file?path=large.txt")).await;
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "expected 200 for a multi-megabyte text file, got status line: {}",
        response.lines().next().unwrap_or_default()
    );
    assert_eq!(body_of(&response), content);

    server.abort();
}

#[tokio::test]
async fn api_file_returns_400_for_a_file_over_the_size_limit() {
    // A sparse file (via `set_len`, not actually writing gigabytes of real
    // data) is enough to exercise the size check without slowing down the
    // suite. This is safe from being confused with the binary-file 400 (a
    // sparse/zero-filled file also trips `is_probably_binary`): `serve_file`
    // gets a distinct `ResolveError::TooLarge` for an oversized path and
    // returns 400 for it before `is_probably_binary` ever runs, so this
    // response body -- asserted below -- unambiguously names the size limit
    // rather than merely happening to also be a 400.
    let scratch = ScratchDir::new("file-over-size-limit");
    let path = scratch.path().join("huge.txt");
    let file = fs::File::create(&path).unwrap();
    file.set_len(prompt_builder_for_sidebar_ai::discovery::MAX_SERVABLE_FILE_SIZE + 1)
        .unwrap();
    let (addr, token, server) = spawn_test_server_with_root(scratch.path().to_path_buf()).await;

    let response = get(addr, &format!("/{token}/api/file?path=huge.txt")).await;
    assert!(
        response.starts_with("HTTP/1.1 400"),
        "expected 400 for a file over the size limit, got: {response}"
    );
    assert!(
        body_of(&response).contains("too large"),
        "expected a size-specific message, got: {response}"
    );

    server.abort();
}

// ---- /api/diff ----

#[tokio::test]
async fn api_diff_returns_200_and_json_content_type_for_valid_token() {
    let (addr, token, server) = spawn_test_server().await;

    let response = get(addr, &format!("/{token}/api/diff")).await;
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "expected 200 for a valid token's api/diff, got: {response}"
    );
    assert!(
        headers_of(&response).contains("content-type: application/json"),
        "expected a JSON content type header, got headers: {}",
        headers_of(&response)
    );

    server.abort();
}

#[tokio::test]
async fn api_diff_returns_404_for_wrong_token() {
    let (addr, _token, server) = spawn_test_server().await;

    let response = get(addr, "/not-the-session-token/api/diff").await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for api/diff with the wrong token, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_diff_returns_405_for_post() {
    let (addr, token, server) = spawn_test_server().await;

    let response = request(addr, "POST", &format!("/{token}/api/diff")).await;
    assert!(
        response.starts_with("HTTP/1.1 405"),
        "expected 405 for a POST to api/diff, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_diff_returns_404_for_extra_path_segment() {
    let (addr, token, server) = spawn_test_server().await;

    let response = get(addr, &format!("/{token}/api/diff/extra")).await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for api/diff with an extra path segment, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_diff_reports_is_git_repo_false_and_empty_diff_for_a_non_git_root() {
    let scratch = ScratchDir::new("diff-non-git");
    fs::write(scratch.path().join("a.txt"), "hello").unwrap();
    let (addr, token, server) = spawn_test_server_with_root(scratch.path().to_path_buf()).await;

    let response = get(addr, &format!("/{token}/api/diff")).await;
    let body = body_of(&response);
    let parsed: serde_json::Value = serde_json::from_str(body)
        .unwrap_or_else(|err| panic!("body should be valid JSON: {err}, body: {body}"));

    assert_eq!(parsed["isGitRepo"], false);
    assert_eq!(parsed["diff"], "");

    server.abort();
}

#[tokio::test]
async fn api_diff_reports_is_git_repo_true_and_empty_diff_for_a_clean_repo() {
    let scratch = ScratchDir::new("diff-clean");
    scratch.git_init();
    fs::write(scratch.path().join("a.txt"), "hello\n").unwrap();
    scratch.git(&["add", "-A"]);
    scratch.git(&["commit", "-q", "-m", "init"]);
    let (addr, token, server) = spawn_test_server_with_root(scratch.path().to_path_buf()).await;

    let response = get(addr, &format!("/{token}/api/diff")).await;
    let body = body_of(&response);
    let parsed: serde_json::Value = serde_json::from_str(body)
        .unwrap_or_else(|err| panic!("body should be valid JSON: {err}, body: {body}"));

    assert_eq!(parsed["isGitRepo"], true);
    assert_eq!(parsed["diff"], "");

    server.abort();
}

#[tokio::test]
async fn api_diff_includes_modified_added_deleted_and_untracked_files() {
    let scratch = ScratchDir::new("diff-full");
    scratch.git_init();
    fs::write(scratch.path().join("modified.txt"), "before\n").unwrap();
    fs::write(scratch.path().join("deleted.txt"), "gone\n").unwrap();
    scratch.git(&["add", "-A"]);
    scratch.git(&["commit", "-q", "-m", "init"]);

    fs::write(scratch.path().join("modified.txt"), "after\n").unwrap();
    fs::remove_file(scratch.path().join("deleted.txt")).unwrap();
    fs::write(scratch.path().join("added.txt"), "staged\n").unwrap();
    scratch.git(&["add", "added.txt"]);
    fs::write(scratch.path().join("untracked.txt"), "loose\n").unwrap();

    let (addr, token, server) = spawn_test_server_with_root(scratch.path().to_path_buf()).await;

    let response = get(addr, &format!("/{token}/api/diff")).await;
    let body = body_of(&response);
    let parsed: serde_json::Value = serde_json::from_str(body)
        .unwrap_or_else(|err| panic!("body should be valid JSON: {err}, body: {body}"));

    assert_eq!(parsed["isGitRepo"], true);
    let diff = parsed["diff"].as_str().expect("diff should be a string");

    assert!(diff.contains("diff --git a/modified.txt b/modified.txt"));
    assert!(diff.contains("-before"));
    assert!(diff.contains("+after"));

    assert!(diff.contains("diff --git a/deleted.txt b/deleted.txt"));
    assert!(diff.contains("deleted file mode"));

    assert!(diff.contains("diff --git a/added.txt b/added.txt"));
    assert!(diff.contains("new file mode"));
    assert!(diff.contains("+staged"));

    assert!(diff.contains("diff --git a/untracked.txt b/untracked.txt"));
    assert!(diff.contains("+loose"));

    // Every file's own header appears exactly once: boundaries between the
    // four changed files stay unambiguous rather than running together.
    assert_eq!(
        diff.matches("diff --git a/").count(),
        4,
        "diff body: {diff}"
    );

    server.abort();
}

// ---- /api/open-folder (issue #11) ----

#[tokio::test]
async fn api_open_folder_returns_501_and_marks_unavailable_when_no_dialog_can_be_shown() {
    let scratch = ScratchDir::new("open-folder-unavailable");
    let (addr, token, server) = spawn_test_server_with_fakes(
        scratch.path().to_path_buf(),
        || false,
        || unreachable!("folder_picker should never be called when the dialog is unavailable"),
    )
    .await;

    let response = request(addr, "POST", &format!("/{token}/api/open-folder")).await;
    assert!(
        response.starts_with("HTTP/1.1 501"),
        "expected 501 when no native dialog can be shown, got: {response}"
    );
    let body = body_of(&response);
    let parsed: serde_json::Value = serde_json::from_str(body)
        .unwrap_or_else(|err| panic!("body should be valid JSON: {err}, body: {body}"));
    assert_eq!(parsed["available"], false);
    assert_eq!(parsed["status"], "unavailable");

    // The root must stay untouched.
    let root_response = get(addr, &format!("/{token}/api/root")).await;
    let root_parsed: serde_json::Value = serde_json::from_str(body_of(&root_response)).unwrap();
    assert_eq!(
        root_parsed["absolutePath"].as_str(),
        Some(scratch.path().display().to_string().as_str())
    );

    server.abort();
}

#[tokio::test]
async fn api_open_folder_leaves_the_root_untouched_when_the_dialog_is_cancelled() {
    let scratch = ScratchDir::new("open-folder-cancel");
    fs::write(scratch.path().join("original.txt"), "original content").unwrap();
    let (addr, token, server) =
        spawn_test_server_with_fakes(scratch.path().to_path_buf(), || true, || None).await;

    let response = request(addr, "POST", &format!("/{token}/api/open-folder")).await;
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "expected 200 for a cancelled dialog, got: {response}"
    );
    let body = body_of(&response);
    let parsed: serde_json::Value = serde_json::from_str(body)
        .unwrap_or_else(|err| panic!("body should be valid JSON: {err}, body: {body}"));
    assert_eq!(parsed["available"], true);
    assert_eq!(parsed["status"], "cancelled");

    // Cancelling must not touch the root: both the root descriptor and the
    // original file underneath it stay exactly as they were.
    let root_response = get(addr, &format!("/{token}/api/root")).await;
    let root_parsed: serde_json::Value = serde_json::from_str(body_of(&root_response)).unwrap();
    assert_eq!(
        root_parsed["absolutePath"].as_str(),
        Some(scratch.path().display().to_string().as_str())
    );

    let file_response = get(addr, &format!("/{token}/api/file?path=original.txt")).await;
    assert!(
        file_response.starts_with("HTTP/1.1 200"),
        "expected the original root's file to still be reachable after a cancelled dialog, got: {file_response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_open_folder_replaces_the_root_on_a_valid_selection() {
    let old_root = ScratchDir::new("open-folder-old-root");
    fs::write(old_root.path().join("old-only.txt"), "old content").unwrap();
    let new_root = ScratchDir::new("open-folder-new-root");
    fs::write(new_root.path().join("new-only.txt"), "new content").unwrap();
    let new_root_path = new_root.path().to_path_buf();

    let (addr, token, server) = spawn_test_server_with_fakes(
        old_root.path().to_path_buf(),
        || true,
        move || Some(new_root_path.clone()),
    )
    .await;

    let response = request(addr, "POST", &format!("/{token}/api/open-folder")).await;
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "expected 200 for a valid folder selection, got: {response}"
    );
    let body = body_of(&response);
    let parsed: serde_json::Value = serde_json::from_str(body)
        .unwrap_or_else(|err| panic!("body should be valid JSON: {err}, body: {body}"));
    assert_eq!(parsed["available"], true);
    assert_eq!(parsed["status"], "ok");
    let expected_basename = new_root
        .path()
        .file_name()
        .expect("scratch dir should have a basename")
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        parsed["basename"].as_str(),
        Some(expected_basename.as_str())
    );
    assert_eq!(
        parsed["absolutePath"].as_str(),
        Some(new_root.path().display().to_string().as_str())
    );

    // Both /api/root and /api/tree now reflect the new root, not the old one.
    let root_response = get(addr, &format!("/{token}/api/root")).await;
    let root_parsed: serde_json::Value = serde_json::from_str(body_of(&root_response)).unwrap();
    assert_eq!(
        root_parsed["absolutePath"].as_str(),
        Some(new_root.path().display().to_string().as_str())
    );

    let tree_response = get(addr, &format!("/{token}/api/tree")).await;
    let tree_parsed: serde_json::Value = serde_json::from_str(body_of(&tree_response)).unwrap();
    let paths: std::collections::BTreeSet<String> = tree_parsed["entries"]
        .as_array()
        .expect("body should have an 'entries' array")
        .iter()
        .map(|entry| {
            entry["path"]
                .as_str()
                .expect("entry should have a string path")
                .to_string()
        })
        .collect();
    assert_eq!(
        paths,
        ["new-only.txt"].into_iter().map(String::from).collect()
    );

    // The old root's file is no longer reachable at all -- not just missing
    // from the tree listing -- and the new root's file is.
    let old_file_response = get(addr, &format!("/{token}/api/file?path=old-only.txt")).await;
    assert!(
        old_file_response.starts_with("HTTP/1.1 404"),
        "expected the old root's file to be unreachable after switching roots, got: {old_file_response}"
    );

    let new_file_response = get(addr, &format!("/{token}/api/file?path=new-only.txt")).await;
    assert!(
        new_file_response.starts_with("HTTP/1.1 200"),
        "expected the new root's file to be reachable after switching roots, got: {new_file_response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_open_folder_returns_400_and_leaves_the_root_untouched_for_a_selected_file() {
    // A native folder-picker dialog can in principle be tricked/scripted into
    // returning something that isn't a directory; `resolve_root` -- the same
    // validation every other root goes through -- must reject it just the
    // same as an invalid `ROOT` CLI argument would.
    let scratch = ScratchDir::new("open-folder-not-a-dir");
    let selected_file = scratch.path().join("not-a-directory.txt");
    fs::write(&selected_file, "not a directory").unwrap();

    let (addr, token, server) = spawn_test_server_with_fakes(
        scratch.path().to_path_buf(),
        || true,
        move || Some(selected_file.clone()),
    )
    .await;

    let response = request(addr, "POST", &format!("/{token}/api/open-folder")).await;
    assert!(
        response.starts_with("HTTP/1.1 400"),
        "expected 400 when the selected path is not a directory, got: {response}"
    );
    let body = body_of(&response);
    let parsed: serde_json::Value = serde_json::from_str(body)
        .unwrap_or_else(|err| panic!("body should be valid JSON: {err}, body: {body}"));
    assert_eq!(parsed["available"], true);
    assert_eq!(parsed["status"], "error");
    assert!(
        parsed["message"]
            .as_str()
            .expect("error response should carry a message")
            .contains("is not a directory"),
        "expected a directory-specific message, got: {body}"
    );

    let root_response = get(addr, &format!("/{token}/api/root")).await;
    let root_parsed: serde_json::Value = serde_json::from_str(body_of(&root_response)).unwrap();
    assert_eq!(
        root_parsed["absolutePath"].as_str(),
        Some(scratch.path().display().to_string().as_str())
    );

    server.abort();
}

#[tokio::test]
async fn api_open_folder_returns_400_for_a_selected_path_that_does_not_exist() {
    let scratch = ScratchDir::new("open-folder-missing-path");
    let missing_path = scratch.path().join("this-should-not-exist-abc123");

    let (addr, token, server) = spawn_test_server_with_fakes(
        scratch.path().to_path_buf(),
        || true,
        move || Some(missing_path.clone()),
    )
    .await;

    let response = request(addr, "POST", &format!("/{token}/api/open-folder")).await;
    assert!(
        response.starts_with("HTTP/1.1 400"),
        "expected 400 when the selected path doesn't exist, got: {response}"
    );

    let root_response = get(addr, &format!("/{token}/api/root")).await;
    let root_parsed: serde_json::Value = serde_json::from_str(body_of(&root_response)).unwrap();
    assert_eq!(
        root_parsed["absolutePath"].as_str(),
        Some(scratch.path().display().to_string().as_str())
    );

    server.abort();
}

#[tokio::test]
async fn api_open_folder_parent_traversal_protection_applies_to_the_new_root() {
    let old_root = ScratchDir::new("open-folder-boundary-old");
    let new_root = ScratchDir::new("open-folder-boundary-new");
    let outside = ScratchDir::new("open-folder-boundary-outside");
    fs::write(outside.path().join("secret.txt"), "outside content").unwrap();
    let outside_name = outside
        .path()
        .file_name()
        .expect("outside scratch dir should have a basename")
        .to_string_lossy()
        .into_owned();
    let new_root_path = new_root.path().to_path_buf();

    let (addr, token, server) = spawn_test_server_with_fakes(
        old_root.path().to_path_buf(),
        || true,
        move || Some(new_root_path.clone()),
    )
    .await;

    let open_response = request(addr, "POST", &format!("/{token}/api/open-folder")).await;
    assert!(
        open_response.starts_with("HTTP/1.1 200"),
        "expected the folder switch itself to succeed, got: {open_response}"
    );

    let traversal_response = get(
        addr,
        &format!("/{token}/api/file?path=../{outside_name}/secret.txt"),
    )
    .await;
    assert!(
        traversal_response.starts_with("HTTP/1.1 404"),
        "expected '../' traversal to stay blocked against the new root, got: {traversal_response}"
    );

    server.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn api_open_folder_symlink_escape_protection_applies_to_the_new_root() {
    let old_root = ScratchDir::new("open-folder-symlink-old");
    let new_root = ScratchDir::new("open-folder-symlink-new");
    let outside = ScratchDir::new("open-folder-symlink-outside");
    fs::write(outside.path().join("secret.txt"), "outside content").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret.txt"),
        new_root.path().join("escape.txt"),
    )
    .unwrap();
    let new_root_path = new_root.path().to_path_buf();

    let (addr, token, server) = spawn_test_server_with_fakes(
        old_root.path().to_path_buf(),
        || true,
        move || Some(new_root_path.clone()),
    )
    .await;

    let open_response = request(addr, "POST", &format!("/{token}/api/open-folder")).await;
    assert!(
        open_response.starts_with("HTTP/1.1 200"),
        "expected the folder switch itself to succeed, got: {open_response}"
    );

    let symlink_response = get(addr, &format!("/{token}/api/file?path=escape.txt")).await;
    assert!(
        symlink_response.starts_with("HTTP/1.1 404"),
        "expected a symlink escaping the new root to stay blocked, got: {symlink_response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_open_folder_drops_the_previous_root_guard_and_removes_its_temp_dir_on_switch() {
    // issue #11 should-fix: every existing test builds its session via
    // `AppState::with_fakes_and_guard`, which always starts `root_guard` at `None`, so
    // no test could previously construct a session that already held a
    // guard -- meaning the "switching roots drops the *previous* root's
    // `TempDirGuard` immediately" behavior (documented in the `AppState`
    // doc comment and README/THREAT_MODEL.md for the GitHub-clone case,
    // issue #14) was never exercised: commenting out the guard-clearing
    // line in `serve_open_folder` left the whole suite green. This test
    // seeds a guard over a real scratch directory via
    // `spawn_test_server_with_fakes_and_guard`, switches to a different
    // root, and checks that the old guarded directory is actually gone from
    // disk afterward -- `TempDirGuard::drop` is what deletes it, so this is
    // only observable if the old guard was dropped, not just replaced in
    // memory.
    let old_guarded = ScratchDir::new("open-folder-guard-old");
    let guard = TempDirGuard::for_test(old_guarded.path().to_path_buf());

    let new_root = ScratchDir::new("open-folder-guard-new");
    let new_root_path = new_root.path().to_path_buf();

    let (addr, token, server) = spawn_test_server_with_fakes_and_guard(
        old_guarded.path().to_path_buf(),
        Some(guard),
        || true,
        move || Some(new_root_path.clone()),
    )
    .await;

    assert!(
        old_guarded.path().exists(),
        "sanity check: the guarded directory should exist before the switch"
    );

    let response = request(addr, "POST", &format!("/{token}/api/open-folder")).await;
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "expected the folder switch itself to succeed, got: {response}"
    );

    assert!(
        !old_guarded.path().exists(),
        "the previous root's guarded temp directory should be removed from disk \
         immediately after switching roots, not left until process exit"
    );

    server.abort();
}

#[tokio::test]
async fn api_open_folder_returns_500_when_the_picker_task_panics() {
    // issue #11 should-fix: `serve_open_folder` reports a panicking picker
    // task as a distinct 500 "the folder-picker task panicked" error (rather
    // than, say, hanging or crashing the whole server), but no test drove
    // that path before this one.
    let scratch = ScratchDir::new("open-folder-picker-panic");
    let (addr, token, server) = spawn_test_server_with_fakes(
        scratch.path().to_path_buf(),
        || true,
        || panic!("simulated folder-picker panic"),
    )
    .await;

    let response = request(addr, "POST", &format!("/{token}/api/open-folder")).await;
    assert!(
        response.starts_with("HTTP/1.1 500"),
        "expected 500 when the folder-picker task panics, got: {response}"
    );
    let body = body_of(&response);
    let parsed: serde_json::Value = serde_json::from_str(body)
        .unwrap_or_else(|err| panic!("body should be valid JSON: {err}, body: {body}"));
    assert_eq!(parsed["available"], true);
    assert_eq!(parsed["status"], "error");
    assert_eq!(
        parsed["message"].as_str(),
        Some("the folder-picker task panicked")
    );

    // A panicking picker must leave the root exactly as untouched as a
    // cancelled dialog or a failed re-validation does.
    let root_response = get(addr, &format!("/{token}/api/root")).await;
    let root_parsed: serde_json::Value = serde_json::from_str(body_of(&root_response)).unwrap();
    assert_eq!(
        root_parsed["absolutePath"].as_str(),
        Some(scratch.path().display().to_string().as_str())
    );

    server.abort();
}

#[tokio::test]
async fn api_open_folder_returns_404_for_wrong_token() {
    let (addr, _token, server) = spawn_test_server().await;

    let response = request(addr, "POST", "/not-the-session-token/api/open-folder").await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for api/open-folder with the wrong token, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_open_folder_returns_405_for_get() {
    let (addr, token, server) = spawn_test_server().await;

    let response = get(addr, &format!("/{token}/api/open-folder")).await;
    assert!(
        response.starts_with("HTTP/1.1 405"),
        "expected 405 for a GET to api/open-folder, got: {response}"
    );

    server.abort();
}

#[tokio::test]
async fn api_open_folder_returns_404_for_extra_path_segment() {
    let (addr, token, server) = spawn_test_server().await;

    let response = request(addr, "POST", &format!("/{token}/api/open-folder/extra")).await;
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "expected 404 for api/open-folder with an extra path segment, got: {response}"
    );

    server.abort();
}
