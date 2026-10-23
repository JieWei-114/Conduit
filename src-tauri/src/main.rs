#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use conduit_tauri::server::store;
use tauri::{AppHandle, Manager, RunEvent, WebviewWindow, WindowEvent};

const FLUSH_TIMEOUT: Duration = Duration::from_millis(1500);
const QUIT_ID: &str = "conduit-quit";

static FLUSH_SEQ: AtomicU64 = AtomicU64::new(0);
static EXITING: AtomicBool = AtomicBool::new(false);
static CLOSING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn flush_webview(w: &WebviewWindow) {
    let id = FLUSH_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let script = format!("window.__conduitFlush && window.__conduitFlush({id})");
    if w.eval(&script).is_err() {
        return;
    }
    let deadline = Instant::now() + FLUSH_TIMEOUT;
    while store::last_flush() < id && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn close_after_flush(app: &AppHandle, label: &str) {
    {
        let mut closing = CLOSING.lock().unwrap_or_else(|e| e.into_inner());
        if !closing.get_or_insert_with(HashSet::new).insert(label.to_string()) {
            return;
        }
    }
    let app = app.clone();
    let label = label.to_string();
    std::thread::spawn(move || {
        if let Some(w) = app.get_webview_window(&label) {
            flush_webview(&w);
            let _ = w.destroy();
        }
        if let Some(set) = CLOSING.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            set.remove(&label);
        }
    });
}

fn exit_after_flush(app: &AppHandle) {
    if EXITING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        for w in app.webview_windows().values() {
            flush_webview(w);
        }
        app.exit(0);
    });
}

#[cfg(target_os = "macos")]
fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};

    let handle = app.handle();
    let menu = Menu::default(handle)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        if let Some(quit) = app_menu.items()?.into_iter().last() {
            app_menu.remove(&quit)?;
        }
        let label = format!("Quit {}", handle.package_info().name);
        app_menu.append(&MenuItem::with_id(handle, QUIT_ID, label, true, Some("CmdOrCtrl+Q"))?)?;
    }
    app.set_menu(menu)?;
    Ok(())
}

fn main() {
    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(7788);

    let app = tauri::Builder::default()
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

            #[cfg(target_os = "macos")]
            install_menu(app)?;

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
        .on_menu_event(|app, event| {
            if event.id() == QUIT_ID {
                exit_after_flush(app);
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if EXITING.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                close_after_flush(window.app_handle(), window.label());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            if !EXITING.load(Ordering::SeqCst) && !app.webview_windows().is_empty() {
                api.prevent_exit();
                exit_after_flush(app);
            }
        }
    });
}
