use prompt_builder_for_sidebar_ai::{build_router, generate_session_token};
use std::net::SocketAddr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Sends a bare-bones HTTP/1.1 GET request over a raw TCP connection and
/// returns the full response text. Kept dependency-free (no HTTP client
/// crate) since this scaffold only needs to observe the status line.
async fn get(addr: SocketAddr, path: &str) -> String {
    let mut stream = TcpStream::connect(addr)
        .await
        .expect("should connect to the local server");

    let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
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

#[tokio::test]
async fn session_path_responds_and_other_paths_are_rejected() {
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
