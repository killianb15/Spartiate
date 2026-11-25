//! API des comptes de Spartiate (profil, statistiques, classement).
//!
//! Elle n'est jamais exposée directement : serveur.py relaie /api/* vers elle (en ajoutant
//! X-Real-IP), et elle seule parle à PostgreSQL, sur un réseau Docker interne sans port publié
//! (voir docker-compose.yml). Variables : DATABASE_URL, ECOUTE (127.0.0.1:8124 par défaut),
//! FREIN_CONNEXION / FREIN_INSCRIPTION (essais par adresse : 10 / 5 min, 5 / heure).

mod defis;
mod securite;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use securite::Freins;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::timeout::TimeoutLayer;

const CORPS_MAX: usize = 4096;
const SESSION_JOURS: i32 = 30;
const MAX_SALLE: i32 = 10_000;
const MAX_ENNEMIS: i32 = 100_000;
const BOSS_TOUS: i32 = 5; // un boss toutes les 5 salles (dungeon.js : bossOf)
const CLASSEMENT: i64 = 10;

#[derive(Clone)]
struct Etat {
    db: PgPool,
    connexion: Arc<Freins>,
    inscription: Arc<Freins>,
    leurre: Arc<String>, // empreinte fictive : un pseudo inconnu coûte autant qu'un mauvais mot de passe
}

// ---------- erreurs : toujours un JSON { erreur } avec un message simple ----------
struct Erreur(StatusCode, &'static str);

impl IntoResponse for Erreur {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "erreur": self.1 }))).into_response()
    }
}

impl From<sqlx::Error> for Erreur {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!("base : {e}");
        Erreur(StatusCode::SERVICE_UNAVAILABLE, "Comptes indisponibles pour l'instant.")
    }
}

const ILLISIBLE: Erreur = Erreur(StatusCode::BAD_REQUEST, "Requête illisible.");
const SESSION: Erreur = Erreur(StatusCode::UNAUTHORIZED, "Session expirée : reconnecte-toi.");
type Rep<T> = Result<Json<T>, Erreur>;

fn lire<T: DeserializeOwned>(corps: &Bytes) -> Result<T, Erreur> {
    serde_json::from_slice(corps).map_err(|_| ILLISIBLE)
}

/// Adresse du joueur : X-Real-IP mis par serveur.py (seul à pouvoir joindre l'API), sinon la connexion.
fn adresse(h: &HeaderMap, ConnectInfo(a): ConnectInfo<SocketAddr>) -> IpAddr {
    h.get("x-real-ip").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse().ok()).unwrap_or(a.ip())
}

fn jeton(h: &HeaderMap) -> Option<&str> {
    let j = h.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")?.trim();
    securite::jeton_plausible(j).then_some(j)
}

#[derive(Serialize, sqlx::FromRow)]
struct Profil {
    pseudo: String,
    parties: i32,
    record: i32,
    ennemis: i32,
    boss: i32,
}

const PROFIL: &str = "SELECT pseudo, parties, record, ennemis, boss FROM joueurs";

/// Profil du joueur + héros débloqués (d'après ses défis réussis).
#[derive(Serialize)]
struct ProfilComplet {
    #[serde(flatten)]
    profil: Profil,
    debloques: Vec<&'static str>,
}

async fn profil_de(db: &PgPool, joueur: i64) -> Result<ProfilComplet, Erreur> {
    let profil = sqlx::query_as::<_, Profil>(&format!("{PROFIL} WHERE id = $1")).bind(joueur).fetch_one(db).await?;
    let reussis = sqlx::query_scalar::<_, String>("SELECT defi FROM defis_reussis WHERE joueur = $1").bind(joueur).fetch_all(db).await?;
    Ok(ProfilComplet { profil, debloques: defis::debloques(&reussis) })
}

/// Joueur de la session, ou 401.
async fn joueur(db: &PgPool, h: &HeaderMap) -> Result<i64, Erreur> {
    let j = jeton(h).ok_or(SESSION)?;
    sqlx::query_scalar::<_, i64>("SELECT joueur FROM sessions WHERE jeton = $1 AND expire_le > now()")
        .bind(securite::empreinte(j))
        .fetch_optional(db)
        .await?
        .ok_or(SESSION)
}

async fn ouvrir_session(db: &PgPool, joueur: i64) -> Result<String, Erreur> {
    let j = securite::nouveau_jeton();
    sqlx::query("INSERT INTO sessions VALUES ($1, $2, now() + make_interval(days => $3))")
        .bind(securite::empreinte(&j))
        .bind(joueur)
        .bind(SESSION_JOURS)
        .execute(db)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE expire_le < now()").execute(db).await?;
    Ok(j)
}

#[derive(Serialize)]
struct Connecte {
    jeton: String,
    profil: ProfilComplet,
}

#[derive(Deserialize)]
struct Identifiants {
    pseudo: String,
    mdp: String,
}

// ---------- routes ----------
async fn sante(State(e): State<Etat>) -> Rep<serde_json::Value> {
    sqlx::query("SELECT 1").execute(&e.db).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn inscription(State(e): State<Etat>, ci: ConnectInfo<SocketAddr>, h: HeaderMap, corps: Bytes) -> Rep<Connecte> {
    if !e.inscription.ok(adresse(&h, ci)) {
        return Err(Erreur(StatusCode::TOO_MANY_REQUESTS, "Trop de comptes créés, réessaie plus tard."));
    }
    let id: Identifiants = lire(&corps)?;
    let pseudo = id.pseudo.trim().to_string();
    if !securite::pseudo_valide(&pseudo) {
        return Err(Erreur(StatusCode::BAD_REQUEST, "Pseudo : 3 à 16 lettres, chiffres, _ ou -."));
    }
    if !securite::mdp_valide(&id.mdp) {
        return Err(Erreur(StatusCode::BAD_REQUEST, "Mot de passe : au moins 6 caractères."));
    }
    let mdp = id.mdp;
    let h = tokio::task::spawn_blocking(move || securite::hacher(&mdp)).await.map_err(|_| ILLISIBLE)?;
    let r = sqlx::query_scalar::<_, i64>("INSERT INTO joueurs (pseudo, mdp) VALUES ($1, $2) RETURNING id")
        .bind(&pseudo)
        .bind(h)
        .fetch_one(&e.db)
        .await;
    let joueur = match r {
        Ok(j) => j,
        Err(sqlx::Error::Database(d)) if d.code().as_deref() == Some("23505") => {
            return Err(Erreur(StatusCode::CONFLICT, "Ce pseudo est déjà pris."));
        }
        Err(x) => return Err(x.into()),
    };
    Ok(Json(Connecte { jeton: ouvrir_session(&e.db, joueur).await?, profil: profil_de(&e.db, joueur).await? }))
}

async fn connexion(State(e): State<Etat>, ci: ConnectInfo<SocketAddr>, h: HeaderMap, corps: Bytes) -> Rep<Connecte> {
    const REFUS: Erreur = Erreur(StatusCode::UNAUTHORIZED, "Pseudo ou mot de passe incorrect.");
    if !e.connexion.ok(adresse(&h, ci)) {
        return Err(Erreur(StatusCode::TOO_MANY_REQUESTS, "Trop d'essais, réessaie dans quelques minutes."));
    }
    let id: Identifiants = lire(&corps)?;
    let pseudo = id.pseudo.trim().to_string();
    let trouve = if securite::pseudo_valide(&pseudo) && id.mdp.len() <= securite::MDP_MAX * 4 {
        sqlx::query_as::<_, (i64, String)>("SELECT id, mdp FROM joueurs WHERE lower(pseudo) = lower($1)")
            .bind(&pseudo)
            .fetch_optional(&e.db)
            .await?
    } else {
        None
    };
    // même travail que le pseudo existe ou non : on ne révèle pas quels pseudos existent
    let stocke = trouve.as_ref().map(|t| t.1.clone()).unwrap_or_else(|| e.leurre.to_string());
    let mdp = id.mdp;
    let bon = tokio::task::spawn_blocking(move || securite::verifier(&mdp, &stocke)).await.map_err(|_| ILLISIBLE)?;
    match trouve {
        Some((j, _)) if bon => Ok(Json(Connecte { jeton: ouvrir_session(&e.db, j).await?, profil: profil_de(&e.db, j).await? })),
        _ => Err(REFUS),
    }
}

async fn deconnexion(State(e): State<Etat>, h: HeaderMap) -> Rep<serde_json::Value> {
    if let Some(j) = jeton(&h) {
        sqlx::query("DELETE FROM sessions WHERE jeton = $1").bind(securite::empreinte(j)).execute(&e.db).await?;
    }
    Ok(Json(json!({})))
}

async fn profil(State(e): State<Etat>, h: HeaderMap) -> Rep<serde_json::Value> {
    let j = joueur(&e.db, &h).await?;
    Ok(Json(json!({ "profil": profil_de(&e.db, j).await? })))
}

#[derive(Deserialize)]
struct Partie {
    salle: i32,
    ennemis: i32, // victimes du héros de ce joueur (et de ses chiens)
    #[serde(default)]
    en_ligne: bool,
    heros: Option<String>,
    arme: Option<String>,
}

/// État de tous les défis d'un joueur (progression calculée sur ses parties).
async fn etat_defis(db: &PgPool, joueur: Option<i64>) -> Result<Vec<defis::Etat>, Erreur> {
    let (mut totaux, mut armes, mut reussis) = (HashMap::new(), HashMap::new(), Vec::new());
    if let Some(j) = joueur {
        for t in sqlx::query_as::<_, defis::Totaux>(defis::TOTAUX_SQL).bind(j).fetch_all(db).await? {
            totaux.insert(t.heros.clone(), t);
        }
        for (h, a, n) in sqlx::query_as::<_, (String, String, i64)>(defis::ARMES_SQL).bind(j).fetch_all(db).await? {
            armes.insert((h, a), n);
        }
        reussis = sqlx::query_scalar::<_, String>("SELECT defi FROM defis_reussis WHERE joueur = $1").bind(j).fetch_all(db).await?;
    }
    Ok(defis::DEFIS
        .iter()
        .map(|d| {
            let progres = defis::progres(d, &totaux, &armes);
            defis::Etat {
                id: d.id,
                heros: d.heros,
                nom: d.nom,
                desc: d.desc,
                objectif: d.objectif,
                progres,
                reussi: progres >= d.objectif || reussis.iter().any(|r| r == d.id),
            }
        })
        .collect())
}

/// Liste des défis ; avec une session valide, la progression du joueur (sinon tout à zéro).
async fn liste_defis(State(e): State<Etat>, h: HeaderMap) -> Rep<serde_json::Value> {
    let j = joueur(&e.db, &h).await.ok();
    Ok(Json(json!({ "defis": etat_defis(&e.db, j).await? })))
}

/// Fin d'un donjon : statistiques du joueur. Les boss vaincus se déduisent de la salle atteinte.
async fn partie(State(e): State<Etat>, h: HeaderMap, corps: Bytes) -> Rep<serde_json::Value> {
    let j = joueur(&e.db, &h).await?;
    let p: Partie = lire(&corps)?;
    let connu = |v: &Option<String>, liste: &[&str]| v.as_deref().is_none_or(|x| liste.contains(&x));
    if !(1..=MAX_SALLE).contains(&p.salle)
        || !(0..=MAX_ENNEMIS).contains(&p.ennemis)
        || !connu(&p.heros, &defis::HEROS)
        || !connu(&p.arme, &defis::ARMES)
    {
        return Err(Erreur(StatusCode::BAD_REQUEST, "Partie invalide."));
    }
    let boss = (p.salle - 1) / BOSS_TOUS;
    let mut tx = e.db.begin().await?;
    sqlx::query("INSERT INTO parties (joueur, salle, ennemis, boss, en_ligne, heros, arme) VALUES ($1, $2, $3, $4, $5, $6, $7)")
        .bind(j)
        .bind(p.salle)
        .bind(p.ennemis)
        .bind(boss)
        .bind(p.en_ligne)
        .bind(&p.heros)
        .bind(&p.arme)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE joueurs SET parties = parties + 1, record = GREATEST(record, $1), ennemis = ennemis + $2, boss = boss + $3 WHERE id = $4",
    )
    .bind(p.salle)
    .bind(p.ennemis)
    .bind(boss)
    .bind(j)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    // défis accomplis par cette partie : enregistrés une seule fois, renvoyés pour les annoncer
    let mut nouveaux = Vec::new();
    for d in etat_defis(&e.db, Some(j)).await?.into_iter().filter(|d| d.progres >= d.objectif) {
        let neuf = sqlx::query("INSERT INTO defis_reussis (joueur, defi) VALUES ($1, $2) ON CONFLICT DO NOTHING")
            .bind(j)
            .bind(d.id)
            .execute(&e.db)
            .await?
            .rows_affected()
            == 1;
        if neuf {
            nouveaux.push(d);
        }
    }
    Ok(Json(json!({ "profil": profil_de(&e.db, j).await?, "nouveaux": nouveaux })))
}

async fn classement(State(e): State<Etat>) -> Rep<serde_json::Value> {
    let c = sqlx::query_as::<_, Profil>(&format!(
        "{PROFIL} WHERE parties > 0 ORDER BY record DESC, ennemis DESC, id LIMIT $1"
    ))
    .bind(CLASSEMENT)
    .fetch_all(&e.db)
    .await?;
    Ok(Json(json!({ "classement": c })))
}

async fn inconnu() -> Erreur {
    Erreur(StatusCode::NOT_FOUND, "Inconnu.")
}

fn env_n(nom: &str, defaut: usize) -> usize {
    std::env::var(nom).ok().and_then(|v| v.parse().ok()).unwrap_or(defaut)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_target(false).init();
    let url = std::env::var("DATABASE_URL").expect("DATABASE_URL manquante");
    let ecoute: SocketAddr = std::env::var("ECOUTE").unwrap_or_else(|_| "127.0.0.1:8124".into()).parse().expect("ECOUTE invalide");

    // la base peut démarrer après nous : on réessaie pendant une minute
    let mut essai = 0;
    let db = loop {
        match PgPoolOptions::new().max_connections(10).acquire_timeout(Duration::from_secs(5)).connect(&url).await {
            Ok(db) => break db,
            Err(e) if essai < 30 => {
                essai += 1;
                tracing::warn!("base injoignable ({e}), nouvel essai…");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(e) => panic!("base injoignable : {e}"),
        }
    };
    sqlx::migrate!("./migrations").run(&db).await.expect("migrations");

    let etat = Etat {
        db,
        connexion: Arc::new(Freins::new(env_n("FREIN_CONNEXION", 10), Duration::from_secs(300))),
        inscription: Arc::new(Freins::new(env_n("FREIN_INSCRIPTION", 5), Duration::from_secs(3600))),
        leurre: Arc::new(securite::hacher("leurre")),
    };
    let app = Router::new()
        .route("/api/sante", get(sante))
        .route("/api/inscription", post(inscription))
        .route("/api/connexion", post(connexion))
        .route("/api/deconnexion", post(deconnexion))
        .route("/api/profil", get(profil))
        .route("/api/partie", post(partie))
        .route("/api/classement", get(classement))
        .route("/api/defis", get(liste_defis))
        .fallback(inconnu)
        .layer(DefaultBodyLimit::max(CORPS_MAX))
        .layer(TimeoutLayer::with_status_code(StatusCode::SERVICE_UNAVAILABLE, Duration::from_secs(10)))
        .layer(SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("no-store")))
        .layer(SetResponseHeaderLayer::overriding(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .with_state(etat);

    let l = tokio::net::TcpListener::bind(ecoute).await.expect("écoute");
    tracing::info!("API des comptes sur {ecoute}");
    axum::serve(l, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("serveur");
}
