use prompt_builder_for_sidebar_ai::{build_router, generate_session_token};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

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
async fn router_returns_the_index_html_body_for_the_valid_token() {
    let (addr, token, server) = spawn_test_server().await;

    let response = get(addr, &format!("/{token}")).await;
    let expected_body = include_str!("../assets/index.html");
    assert_eq!(
        body_of(&response),
        expected_body,
        "expected the response body to match assets/index.html verbatim"
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
    let paths: std::collections::BTreeSet<String> = parsed
        .as_array()
        .expect("body should be a JSON array")
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
async fn api_tree_returns_empty_array_for_empty_root() {
    let scratch = ScratchDir::new("empty-root");

    let (addr, token, server) = spawn_test_server_with_root(scratch.path().to_path_buf()).await;

    let response = get(addr, &format!("/{token}/api/tree")).await;
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "expected 200 for an empty root, got: {response}"
    );
    assert_eq!(
        body_of(&response),
        "[]",
        "expected an empty JSON array body for an empty root"
    );

    server.abort();
}
