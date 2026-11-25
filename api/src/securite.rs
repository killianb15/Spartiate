//! Règles de sécurité des comptes : pseudos, mots de passe (Argon2id), jetons de session,
//! limitation des essais par adresse.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const MDP_MIN: usize = 6;
pub const MDP_MAX: usize = 128;

/// Pseudo : 3 à 16 caractères, lettres latines (accents compris), chiffres, `_` ou `-`.
pub fn pseudo_valide(p: &str) -> bool {
    let n = p.chars().count();
    (3..=16).contains(&n)
        && p.chars().all(|c| {
            c.is_ascii_alphanumeric() || c == '_' || c == '-' || (('À'..='ÿ').contains(&c) && c != '×' && c != '÷')
        })
}

pub fn mdp_valide(m: &str) -> bool {
    (MDP_MIN..=MDP_MAX).contains(&m.chars().count())
}

/// Empreinte Argon2id (paramètres par défaut recommandés), au format PHC. Coûteux : à appeler hors
/// du fil asynchrone (spawn_blocking).
pub fn hacher(mdp: &str) -> String {
    let sel = SaltString::generate(&mut OsRng);
    Argon2::default().hash_password(mdp.as_bytes(), &sel).expect("argon2").to_string()
}

pub fn verifier(mdp: &str, stocke: &str) -> bool {
    match PasswordHash::new(stocke) {
        Ok(h) => Argon2::default().verify_password(mdp.as_bytes(), &h).is_ok(),
        Err(_) => false,
    }
}

/// Nouveau jeton de session (256 bits aléatoires, base64 URL).
pub fn nouveau_jeton() -> String {
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/// Seule l'empreinte du jeton est stockée : une fuite de la base ne donne accès à aucune session.
pub fn empreinte(jeton: &str) -> String {
    hex::encode(Sha256::digest(jeton.as_bytes()))
}

pub fn jeton_plausible(j: &str) -> bool {
    (20..=100).contains(&j.len()) && j.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Au plus `n` essais par adresse sur une fenêtre glissante de `fenetre`.
pub struct Freins {
    n: usize,
    fenetre: Duration,
    essais: Mutex<HashMap<IpAddr, Vec<Instant>>>,
}

impl Freins {
    pub fn new(n: usize, fenetre: Duration) -> Self {
        Freins { n, fenetre, essais: Mutex::new(HashMap::new()) }
    }

    pub fn ok(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut m = self.essais.lock().unwrap_or_else(|e| e.into_inner());
        if m.len() > 10_000 {
            let f = self.fenetre;
            m.retain(|_, t| t.last().is_some_and(|&x| now.duration_since(x) < f));
        }
        let t = m.entry(ip).or_default();
        t.retain(|&x| now.duration_since(x) < self.fenetre);
        if t.len() >= self.n {
            return false;
        }
        t.push(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pseudos() {
        for ok in ["Leo", "Léonidas", "Éponine-2", "a_b", "abcdefghijklmnop"] {
            assert!(pseudo_valide(ok), "{ok}");
        }
        for ko in ["ab", "a b", "abcdefghijklmnopq", "<script>", "x×y", "Λεωνίδας", "", "a\u{0}b", "😀😀😀"] {
            assert!(!pseudo_valide(ko), "{ko}");
        }
    }

    #[test]
    fn mots_de_passe() {
        let h = hacher("thermopyles");
        assert!(h.starts_with("$argon2id$"));
        assert!(!h.contains("thermopyles"));
        assert!(verifier("thermopyles", &h));
        assert!(!verifier("Thermopyles", &h));
        assert!(!verifier("thermopyles", "n'importe quoi"));
        assert_ne!(hacher("thermopyles"), h, "sel aléatoire");
        assert!(!mdp_valide("court") && mdp_valide("assez long") && !mdp_valide(&"x".repeat(129)));
    }

    #[test]
    fn jetons() {
        let j = nouveau_jeton();
        assert_eq!(j.len(), 43);
        assert!(jeton_plausible(&j));
        assert_ne!(j, nouveau_jeton());
        assert_eq!(empreinte(&j).len(), 64);
        assert!(!jeton_plausible("court") && !jeton_plausible(&"a\r\nb".repeat(10)));
    }

    #[test]
    fn freins() {
        let f = Freins::new(3, Duration::from_secs(60));
        let a: IpAddr = "10.0.0.1".parse().unwrap();
        let b: IpAddr = "10.0.0.2".parse().unwrap();
        assert!(f.ok(a) && f.ok(a) && f.ok(a));
        assert!(!f.ok(a));
        assert!(f.ok(b), "une autre adresse n'est pas freinée");
    }
}
