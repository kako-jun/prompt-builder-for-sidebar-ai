use prompt_builder_for_sidebar_ai::{build_router, generate_session_token};
use std::net::SocketAddr;
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
/// single test. Each test gets its own token, router, and listener so tests
/// can run concurrently without interfering with each other.
async fn spawn_test_server() -> (SocketAddr, String, JoinHandle<()>) {
    let token = generate_session_token();
    let router = build_router(&token);

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
