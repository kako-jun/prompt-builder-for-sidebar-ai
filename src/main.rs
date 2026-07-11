use clap::Parser;
use prompt_builder_for_sidebar_ai::github_root::{parse_github_root_url, resolve_root_arg};
use prompt_builder_for_sidebar_ai::{build_router, generate_session_token};
use std::process::ExitCode;
use tokio::net::TcpListener;

/// A local browser that builds prompts for sidebar AI from your files.
#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
struct Cli {
    /// Root directory to serve, or a public GitHub repository URL
    /// (`https://github.com/{owner}/{repo}`, optionally with `/tree/{ref}`
    /// for a specific branch or tag). Defaults to the current directory.
    #[arg(default_value = ".")]
    root: String,
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();

    // `_root_clone_guard` is never read again after this -- it only needs to
    // stay alive until the end of `main` so its `Drop` impl removes the
    // temporary clone directory on exit. `None` for an ordinary local-path
    // `ROOT`, which never creates one.
    let (root, _root_clone_guard) = match resolve_root_arg(&cli.root) {
        Ok(result) => result,
        Err(err) => {
            eprintln!("error: {err}");
            return ExitCode::FAILURE;
        }
    };

    let token = generate_session_token();
    let router = build_router(&token, root.clone());

    let listener = match TcpListener::bind("127.0.0.1:0").await {
        Ok(listener) => listener,
        Err(err) => {
            eprintln!("error: failed to bind a localhost port: {err}");
            return ExitCode::FAILURE;
        }
    };

    let addr = match listener.local_addr() {
        Ok(addr) => addr,
        Err(err) => {
            eprintln!("error: failed to read the bound address: {err}");
            return ExitCode::FAILURE;
        }
    };

    let session_url = format!("http://{addr}/{token}");
    match parse_github_root_url(&cli.root) {
        Some(_) => println!(
            "serving '{}' (cloned from {}) at {session_url}",
            root.display(),
            cli.root
        ),
        None => println!("serving '{}' at {session_url}", root.display()),
    }

    if let Err(err) = open::that(&session_url) {
        eprintln!("warning: could not open the browser automatically: {err}");
        eprintln!("open this URL manually: {session_url}");
    }

    if let Err(err) = axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        eprintln!("error: server error: {err}");
        return ExitCode::FAILURE;
    }

    ExitCode::SUCCESS
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("failed to listen for ctrl-c");
    println!("shutting down");
}
