pub mod attempt;
pub mod db;
pub mod diag;
pub mod grpc;
pub mod grpc_reflect;
pub mod grpc_status;
pub mod http;
pub mod kafka;
pub mod ops;
pub mod pulsar;
pub mod redis;
pub mod redis_conn;
pub mod sse;
pub mod static_files;
pub mod store;
pub mod webhook;
pub mod ws;

use std::future::IntoFuture;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};

use axum::Router;

pub fn app() -> Router {
    Router::new()
        .nest("/api/db", db::routes())
        .nest("/api/diag", diag::routes())
        .nest("/api/grpc", grpc::routes().merge(grpc_reflect::routes()))
        // files go base64 in the JSON body, and the UI allows 25 MB of them
        .nest("/api/http", http::routes().layer(axum::extract::DefaultBodyLimit::max(48 * 1024 * 1024)))
        .nest("/api/kafka", kafka::routes())
        .nest("/api/ops", ops::routes())
        .nest("/api/pulsar", pulsar::routes())
        .nest("/api/redis", redis::routes())
        .nest("/api/sse", sse::routes())
        .nest("/api/store", store::routes())
        .nest("/api/webhook", webhook::routes())
        .nest("/api/ws", ws::routes())
        .fallback(static_files::handler)
}

pub async fn serve(port: u16) -> std::io::Result<()> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Bind both loopback stacks so `localhost` works whether it resolves to
    // 127.0.0.1 or ::1 (macOS prefers IPv6).
    let v4 = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let v6 = SocketAddr::from((Ipv6Addr::LOCALHOST, port));
    let l4 = tokio::net::TcpListener::bind(v4).await?;
    let l6 = tokio::net::TcpListener::bind(v6).await?;
    println!("conduit rust server on http://{v4} and http://[{}]:{port}", Ipv6Addr::LOCALHOST);

    let s4 = axum::serve(l4, app().into_make_service_with_connect_info::<SocketAddr>());
    let s6 = axum::serve(l6, app().into_make_service_with_connect_info::<SocketAddr>());
    tokio::try_join!(s4.into_future(), s6.into_future())?;
    Ok(())
}
