#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

fn main() {
    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(7788);

    tauri::Builder::default()
        .setup(move |app| {
            // In a bundled build the working dir is not the repo, so pin the
            // settings file to a stable per-user location. In dev (debug) leave
            // it unset so the repo's conduit-data.json is used.
            if !cfg!(debug_assertions) && std::env::var("CONDUIT_DATA").is_err() {
                if let Ok(dir) = app.path().app_data_dir() {
                    let _ = std::fs::create_dir_all(&dir);
                    std::env::set_var("CONDUIT_DATA", dir.join("conduit-data.json"));
                }
            }

            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
                rt.block_on(async move {
                    if let Err(e) = conduit_tauri::server::serve(port).await {
                        eprintln!("server error: {e}");
                    }
                });
            });

            // The window loads http://localhost:PORT, so wait for the server to
            // accept before the webview navigates (avoids a connection-refused
            // splash on cold start).
            let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
            for _ in 0..100 {
                if std::net::TcpStream::connect_timeout(
                    &addr,
                    std::time::Duration::from_millis(100),
                )
                .is_ok()
                {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
