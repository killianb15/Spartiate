//! Amis et classements.
//!
//! Une demande d'ami est une ligne (de -> vers) de la table `amis` ; elle devient une amitié quand le
//! destinataire l'accepte (en ajoutant à son tour le demandeur). Une seule ligne par paire.
//! serveur.py lit la liste des amis (GET /api/amis, avec le jeton du joueur) pour montrer lesquels sont
//! en ligne ou ont ouvert un salon, et pour n'autoriser les invitations qu'entre amis.

use crate::{joueur, lire, Erreur, Etat, Rep, CLASSEMENT};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgPool;

/// Lignes (amitiés et demandes, dans les deux sens) au plus par joueur.
pub const AMIS_MAX: i64 = 100;
/// Demandes envoyées en attente au plus (contre l'envoi en masse).
pub const ENVOYEES_MAX: i64 = 20;

#[derive(Deserialize)]
struct Cible {
    pseudo: String,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Ami {
    pseudo: String,
    record: i32,
    parties: i32,
}

/// Amis (acceptés), demandes reçues et demandes envoyées, chacun trié par pseudo.
async fn liste(db: &PgPool, j: i64) -> Result<serde_json::Value, Erreur> {
    let amis = sqlx::query_as::<_, Ami>(
        "SELECT p.pseudo, p.record, p.parties FROM amis a JOIN joueurs p ON p.id = CASE WHEN a.de = $1 THEN a.vers ELSE a.de END
         WHERE (a.de = $1 OR a.vers = $1) AND a.accepte ORDER BY lower(p.pseudo)",
    )
    .bind(j)
    .fetch_all(db)
    .await?;
    let attente = |sql: &'static str| sqlx::query_scalar::<_, String>(sql).bind(j).fetch_all(db);
    let recues = attente("SELECT p.pseudo FROM amis a JOIN joueurs p ON p.id = a.de WHERE a.vers = $1 AND NOT a.accepte ORDER BY a.cree_le").await?;
    let envoyees = attente("SELECT p.pseudo FROM amis a JOIN joueurs p ON p.id = a.vers WHERE a.de = $1 AND NOT a.accepte ORDER BY a.cree_le").await?;
    Ok(json!({ "amis": amis, "recues": recues, "envoyees": envoyees }))
}

/// Identifiant et pseudo exact d'un joueur d'après son pseudo (casse ignorée).
async fn trouver(db: &PgPool, pseudo: &str) -> Result<(i64, String), Erreur> {
    let p = pseudo.trim();
    if !crate::securite::pseudo_valide(p) {
        return Err(Erreur(StatusCode::NOT_FOUND, "Aucun joueur avec ce pseudo."));
    }
    sqlx::query_as::<_, (i64, String)>("SELECT id, pseudo FROM joueurs WHERE lower(pseudo) = lower($1)")
        .bind(p)
        .fetch_optional(db)
        .await?
        .ok_or(Erreur(StatusCode::NOT_FOUND, "Aucun joueur avec ce pseudo."))
}

pub async fn amis(State(e): State<Etat>, h: HeaderMap) -> Rep<serde_json::Value> {
    let j = joueur(&e.db, &h).await?;
    Ok(Json(liste(&e.db, j).await?))
}

/// Ajouter un ami : envoie une demande, ou accepte celle qu'il nous a envoyée.
pub async fn ajouter(State(e): State<Etat>, h: HeaderMap, corps: Bytes) -> Rep<serde_json::Value> {
    let j = joueur(&e.db, &h).await?;
    let c: Cible = lire(&corps)?;
    let (autre, nom) = trouver(&e.db, &c.pseudo).await?;
    if autre == j {
        return Err(Erreur(StatusCode::BAD_REQUEST, "C'est ton propre pseudo !"));
    }
    let lien = sqlx::query_as::<_, (i64, bool)>("SELECT de, accepte FROM amis WHERE (de = $1 AND vers = $2) OR (de = $2 AND vers = $1)")
        .bind(j)
        .bind(autre)
        .fetch_all(&e.db)
        .await?;
    let msg = if lien.iter().any(|l| l.1) {
        format!("{nom} est déjà ton ami.")
    } else if lien.iter().any(|l| l.0 == autre) {
        // il nous avait demandé : on accepte (et on retire une éventuelle demande croisée)
        let mut tx = e.db.begin().await?;
        sqlx::query("UPDATE amis SET accepte = true WHERE de = $2 AND vers = $1").bind(j).bind(autre).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM amis WHERE de = $1 AND vers = $2").bind(j).bind(autre).execute(&mut *tx).await?;
        tx.commit().await?;
        format!("{nom} est maintenant ton ami.")
    } else if !lien.is_empty() {
        format!("Demande déjà envoyée à {nom}.")
    } else {
        let (total, envoyees) = sqlx::query_as::<_, (i64, i64)>(
            "SELECT count(*), count(*) FILTER (WHERE de = $1 AND NOT accepte) FROM amis WHERE de = $1 OR vers = $1",
        )
        .bind(j)
        .fetch_one(&e.db)
        .await?;
        if total >= AMIS_MAX {
            return Err(Erreur(StatusCode::BAD_REQUEST, "Ta liste d'amis est pleine."));
        }
        if envoyees >= ENVOYEES_MAX {
            return Err(Erreur(StatusCode::TOO_MANY_REQUESTS, "Trop de demandes en attente : attends qu'on te réponde."));
        }
        sqlx::query("INSERT INTO amis (de, vers) VALUES ($1, $2) ON CONFLICT DO NOTHING").bind(j).bind(autre).execute(&e.db).await?;
        format!("Demande envoyée à {nom}.")
    };
    let mut r = liste(&e.db, j).await?;
    r["msg"] = json!(msg);
    Ok(Json(r))
}

/// Retirer un ami, refuser sa demande ou annuler la nôtre.
pub async fn retirer(State(e): State<Etat>, h: HeaderMap, corps: Bytes) -> Rep<serde_json::Value> {
    let j = joueur(&e.db, &h).await?;
    let c: Cible = lire(&corps)?;
    if let Ok((autre, _)) = trouver(&e.db, &c.pseudo).await {
        sqlx::query("DELETE FROM amis WHERE (de = $1 AND vers = $2) OR (de = $2 AND vers = $1)").bind(j).bind(autre).execute(&e.db).await?;
    }
    Ok(Json(liste(&e.db, j).await?))
}

// ---------- classements ----------

/// Une ligne de classement : rang, statistiques, et héros/arme de la meilleure partie.
#[derive(Serialize, sqlx::FromRow)]
pub struct Ligne {
    rang: i64,
    pseudo: String,
    record: i32,
    ennemis: i32,
    parties: i32,
    boss: i32,
    heros: Option<String>,
    arme: Option<String>,
}

/// Joueurs classés (au moins une partie), avec leur rang mondial ; `filtre` restreint les lignes rendues.
fn classes(filtre: &str) -> String {
    format!(
        "SELECT c.rang, c.pseudo, c.record, c.ennemis, c.parties, c.boss, b.heros, b.arme FROM (
           SELECT id, pseudo, record, ennemis, parties, boss,
                  row_number() OVER (ORDER BY record DESC, ennemis DESC, id) AS rang
           FROM joueurs WHERE parties > 0) c
         LEFT JOIN LATERAL (SELECT heros, arme FROM parties p WHERE p.joueur = c.id ORDER BY salle DESC, jouee_le LIMIT 1) b ON true
         WHERE {filtre} ORDER BY c.rang"
    )
}

/// Classement mondial (les CLASSEMENT premiers) ; avec une session valide, la place du joueur (`moi`).
pub async fn classement(State(e): State<Etat>, h: HeaderMap) -> Rep<serde_json::Value> {
    let top = sqlx::query_as::<_, Ligne>(&format!("{} LIMIT $1", classes("true"))).bind(CLASSEMENT).fetch_all(&e.db).await?;
    let moi = match joueur(&e.db, &h).await {
        Ok(j) => sqlx::query_as::<_, Ligne>(&classes("c.id = $1")).bind(j).fetch_optional(&e.db).await?,
        Err(_) => None,
    };
    Ok(Json(json!({ "classement": top, "moi": moi })))
}

/// Classement entre amis : le joueur et ses amis (rang mondial gardé, `place` = rang entre amis).
pub async fn classement_amis(State(e): State<Etat>, h: HeaderMap) -> Rep<serde_json::Value> {
    let j = joueur(&e.db, &h).await?;
    let lignes = sqlx::query_as::<_, Ligne>(&classes(
        "c.id = $1 OR c.id IN (SELECT CASE WHEN de = $1 THEN vers ELSE de END FROM amis WHERE (de = $1 OR vers = $1) AND accepte)",
    ))
    .bind(j)
    .fetch_all(&e.db)
    .await?;
    Ok(Json(json!({ "classement": lignes })))
}
