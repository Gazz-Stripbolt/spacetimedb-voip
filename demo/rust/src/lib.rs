//! Demo: voice rooms plus a proximity "campfire" where you walk around a 2D map.
//! Serves the web client at `/route/`.

#[path = "../../../rust/voip.rs"]
pub mod voip;

use http::{StatusCode, header};
use spacetimedb::http::{Body, HandlerContext, Request, Response, Router, handler, router};
use spacetimedb::{Identity, ReducerContext, Table};
use voip::{VoipRoomOptions, VoipVec3};

const PAGE: &str = include_str!("../../web/dist/index.html");
/// The campfire map is 0..MAP x 0..MAP.
const MAP: f32 = 100.0;

#[spacetimedb::table(accessor = demo_player, public)]
pub struct DemoPlayer {
    #[primary_key]
    pub identity: Identity,
    pub name: String,
    pub x: f32,
    pub y: f32,
}

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) -> Result<(), String> {
    voip::configure(ctx, voip::VoipSettings::default());
    voip::create_room(ctx, "Lobby", VoipRoomOptions::default())?;
    voip::create_room(
        ctx,
        "Campfire",
        VoipRoomOptions {
            spatial: true,
            range: 30.0,
            ..Default::default()
        },
    )?;
    // Locked: only module code can put people here (see `voip::join`). The demo never does.
    voip::create_room(
        ctx,
        "Staff",
        VoipRoomOptions {
            locked: true,
            ..Default::default()
        },
    )?;
    Ok(())
}

#[spacetimedb::reducer(client_connected)]
pub fn connected(ctx: &ReducerContext) {
    voip::on_connect(ctx);
    if ctx.db.demo_player().identity().find(ctx.sender()).is_none() {
        let hex = ctx.sender().to_hex().to_string();
        // Spread newcomers around the middle of the map, deterministically.
        let seed = u32::from_str_radix(&hex[hex.len() - 4..], 16).unwrap_or(0);
        let x = 35.0 + (seed % 30) as f32;
        let y = 35.0 + (seed / 30 % 30) as f32;
        ctx.db.demo_player().insert(DemoPlayer {
            identity: ctx.sender(),
            name: format!("guest-{}", &hex[hex.len() - 4..]),
            x,
            y,
        });
    }
    sync_position(ctx, ctx.sender());
}

#[spacetimedb::reducer(client_disconnected)]
pub fn disconnected(ctx: &ReducerContext) {
    voip::on_disconnect(ctx);
}

#[spacetimedb::reducer]
pub fn demo_set_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > 24 {
        return Err("name must be 1-24 characters".into());
    }
    let p = ctx.demo_player_or_err()?;
    ctx.db
        .demo_player()
        .identity()
        .update(DemoPlayer { name, ..p });
    Ok(())
}

/// Move on the campfire map. The module, not the client, tells voip where you are.
#[spacetimedb::reducer]
pub fn demo_move(ctx: &ReducerContext, x: f32, y: f32) -> Result<(), String> {
    if !(x.is_finite() && y.is_finite()) {
        return Err("bad position".into());
    }
    let p = ctx.demo_player_or_err()?;
    ctx.db.demo_player().identity().update(DemoPlayer {
        x: x.clamp(0.0, MAP),
        y: y.clamp(0.0, MAP),
        ..p
    });
    sync_position(ctx, ctx.sender());
    Ok(())
}

fn sync_position(ctx: &ReducerContext, who: Identity) {
    if let Some(p) = ctx.db.demo_player().identity().find(who) {
        voip::set_position(
            ctx,
            who,
            VoipVec3 {
                x: p.x,
                y: p.y,
                z: 0.0,
            },
        );
    }
}

trait PlayerExt {
    fn demo_player_or_err(&self) -> Result<DemoPlayer, String>;
}

impl PlayerExt for ReducerContext {
    fn demo_player_or_err(&self) -> Result<DemoPlayer, String> {
        self.db
            .demo_player()
            .identity()
            .find(self.sender())
            .ok_or_else(|| "not connected".into())
    }
}

#[handler]
fn page(_ctx: &mut HandlerContext, _req: Request) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_bytes(PAGE))
        .unwrap()
}

#[router]
fn router() -> Router {
    Router::new().get("/", page)
}
