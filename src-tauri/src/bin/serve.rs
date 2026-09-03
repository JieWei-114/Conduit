#[tokio::main]
async fn main() {
    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(7788);
    if let Err(e) = conduit_tauri::server::serve(port).await {
        eprintln!("server error: {e}");
        std::process::exit(1);
    }
}
