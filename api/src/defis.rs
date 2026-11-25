//! Défis des héros. La progression se calcule sur les parties du joueur avec ce héros (table parties) ;
//! ajouter un défi = ajouter une ligne à DEFIS (identifiant stable : il est gardé dans defis_reussis).

use serde::Serialize;
use std::collections::HashMap;

/// Héros et armes connus du jeu (dungeon.js : HEROES, sim.js : WEAPONS) : le reste est refusé.
/// HEROS est aussi l'ordre de déblocage : le premier est jouable d'emblée, chacun des suivants se
/// débloque en réussissant un défi du précédent.
pub const HEROS: [&str; 7] = ["soldier", "human", "orc", "archer", "knight", "zombie", "robot"];
pub const ARMES: [&str; 9] = ["sword", "spear", "tower", "axe", "hammer", "staff", "tome", "gloves", "bow"];

#[derive(Clone, Copy)]
pub enum Mesure {
    Ennemis,              // ennemis vaincus (cumul)
    Salles,               // salles traversées (cumul : salle atteinte - 1 par partie)
    Record,               // meilleure salle atteinte en une partie
    Boss,                 // boss vaincus (cumul)
    Arme(&'static str),   // ennemis vaincus avec cette arme
    EnLigne,              // donjons terminés à deux en ligne
    Parties,              // donjons terminés
}

pub struct Defi {
    pub id: &'static str,
    pub heros: &'static str,
    pub nom: &'static str,
    pub desc: &'static str,
    pub mesure: Mesure,
    pub objectif: i64,
}

const fn d(id: &'static str, heros: &'static str, nom: &'static str, desc: &'static str, mesure: Mesure, objectif: i64) -> Defi {
    Defi { id, heros, nom, desc, mesure, objectif }
}

use Mesure::*;
pub const DEFIS: &[Defi] = &[
    d("soldier.ennemis", "soldier", "Premier sang", "Vaincre 100 ennemis", Ennemis, 100),
    d("soldier.salles", "soldier", "Survivant", "Survivre à 100 salles", Salles, 100),
    d("soldier.record", "soldier", "Champion de l'arène", "Atteindre la salle 20", Record, 20),
    d("soldier.glaive", "soldier", "Maître d'armes", "Vaincre 50 ennemis au glaive", Arme("sword"), 50),

    d("human.ennemis", "human", "Premier sang", "Vaincre 100 ennemis", Ennemis, 100),
    d("human.salles", "human", "Survivant", "Survivre à 100 salles", Salles, 100),
    d("human.boss", "human", "Tueur de géants", "Vaincre 5 boss", Boss, 5),
    d("human.en_ligne", "human", "Frère d'armes", "Finir 10 donjons à deux en ligne", EnLigne, 10),

    d("orc.ennemis", "orc", "Premier sang", "Vaincre 100 ennemis", Ennemis, 100),
    d("orc.salles", "orc", "Survivant", "Survivre à 100 salles", Salles, 100),
    d("orc.hache", "orc", "Brise-crânes", "Vaincre 100 ennemis à la hache", Arme("axe"), 100),
    d("orc.record", "orc", "Increvable", "Atteindre la salle 25", Record, 25),

    d("archer.ennemis", "archer", "Premier sang", "Vaincre 100 ennemis", Ennemis, 100),
    d("archer.salles", "archer", "Survivante", "Survivre à 100 salles", Salles, 100),
    d("archer.arc", "archer", "Œil de faucon", "Vaincre 150 ennemis à l'arc", Arme("bow"), 150),
    d("archer.boss", "archer", "Chasseuse de monstres", "Vaincre 5 boss", Boss, 5),

    d("knight.ennemis", "knight", "Premier sang", "Vaincre 100 ennemis", Ennemis, 100),
    d("knight.salles", "knight", "Survivant", "Survivre à 100 salles", Salles, 100),
    d("knight.record", "knight", "Rempart", "Atteindre la salle 30", Record, 30),
    d("knight.pavois", "knight", "Bastion", "Vaincre 50 ennemis avec l'épée et le pavois", Arme("tower"), 50),

    d("zombie.ennemis", "zombie", "Premier sang", "Vaincre 100 ennemis", Ennemis, 100),
    d("zombie.salles", "zombie", "Survivant", "Survivre à 100 salles", Salles, 100),
    d("zombie.horde", "zombie", "La horde", "Vaincre 500 ennemis", Ennemis, 500),
    d("zombie.parties", "zombie", "Revenant", "Finir 25 donjons", Parties, 25),

    d("robot.ennemis", "robot", "Premier sang", "Vaincre 100 ennemis", Ennemis, 100),
    d("robot.salles", "robot", "Survivant", "Survivre à 100 salles", Salles, 100),
    d("robot.boss", "robot", "Machine de guerre", "Vaincre 10 boss", Boss, 10),
    d("robot.record", "robot", "Inarrêtable", "Atteindre la salle 40", Record, 40),
];

/// Totaux des parties d'un joueur avec un héros.
#[derive(Default, sqlx::FromRow)]
pub struct Totaux {
    pub heros: String,
    pub parties: i64,
    pub ennemis: i64,
    pub salles: i64,
    pub record: i64,
    pub boss: i64,
    pub en_ligne: i64,
}

pub const TOTAUX_SQL: &str = "SELECT heros, COUNT(*) AS parties, COALESCE(SUM(ennemis), 0)::BIGINT AS ennemis, \
    COALESCE(SUM(salle - 1), 0)::BIGINT AS salles, COALESCE(MAX(salle), 0)::BIGINT AS record, \
    COALESCE(SUM(boss), 0)::BIGINT AS boss, COUNT(*) FILTER (WHERE en_ligne) AS en_ligne \
    FROM parties WHERE joueur = $1 AND heros IS NOT NULL GROUP BY heros";
pub const ARMES_SQL: &str = "SELECT heros, arme, COALESCE(SUM(ennemis), 0)::BIGINT FROM parties \
    WHERE joueur = $1 AND heros IS NOT NULL AND arme IS NOT NULL GROUP BY heros, arme";

/// Progression d'un défi d'après les totaux (héros) et les victimes par (héros, arme).
pub fn progres(d: &Defi, totaux: &HashMap<String, Totaux>, armes: &HashMap<(String, String), i64>) -> i64 {
    let vide = Totaux::default();
    let t = totaux.get(d.heros).unwrap_or(&vide);
    let v = match d.mesure {
        Ennemis => t.ennemis,
        Salles => t.salles,
        Record => t.record,
        Boss => t.boss,
        Arme(a) => *armes.get(&(d.heros.to_string(), a.to_string())).unwrap_or(&0),
        EnLigne => t.en_ligne,
        Parties => t.parties,
    };
    v.min(d.objectif)
}

/// Héros débloqués d'après les défis réussis : on suit la chaîne tant que le héros précédent a un défi réussi.
pub fn debloques(reussis: &[String]) -> Vec<&'static str> {
    let mut v = vec![HEROS[0]];
    for w in HEROS.windows(2) {
        let prefixe = format!("{}.", w[0]);
        if !reussis.iter().any(|r| r.starts_with(&prefixe)) {
            break;
        }
        v.push(w[1]);
    }
    v
}

#[derive(Serialize)]
pub struct Etat {
    pub id: &'static str,
    pub heros: &'static str,
    pub nom: &'static str,
    pub desc: &'static str,
    pub objectif: i64,
    pub progres: i64,
    pub reussi: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn liste_coherente() {
        let mut ids = std::collections::HashSet::new();
        for d in DEFIS {
            assert!(ids.insert(d.id), "identifiant en double : {}", d.id);
            assert!(HEROS.contains(&d.heros), "{}", d.id);
            assert!(d.id.starts_with(&format!("{}.", d.heros)), "{}", d.id);
            assert!(d.objectif > 0);
            if let Arme(a) = d.mesure {
                assert!(ARMES.contains(&a), "{}", d.id);
            }
        }
        for h in HEROS {
            assert!(DEFIS.iter().filter(|d| d.heros == h).count() >= 4, "{h} : au moins 4 défis");
        }
    }

    #[test]
    fn deblocage_en_chaine() {
        let r = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(debloques(&[]), vec!["soldier"]);
        assert_eq!(debloques(&r(&["soldier.ennemis"])), vec!["soldier", "human"]);
        assert_eq!(debloques(&r(&["soldier.record", "human.boss", "orc.hache"])), vec!["soldier", "human", "orc", "archer"]);
        // trou dans la chaîne : rien après lui (un défi de l'Orc seul ne débloque pas l'Archère)
        assert_eq!(debloques(&r(&["orc.hache"])), vec!["soldier"]);
        assert_eq!(debloques(&r(&["soldier.ennemis", "orc.hache"])), vec!["soldier", "human"]);
        let tout: Vec<String> = HEROS.iter().map(|h| format!("{h}.ennemis")).collect();
        assert_eq!(debloques(&tout), HEROS.to_vec());
    }

    #[test]
    fn progression() {
        let mut t = HashMap::new();
        t.insert("orc".to_string(), Totaux { heros: "orc".into(), parties: 3, ennemis: 40, salles: 120, record: 12, boss: 2, en_ligne: 1 });
        let mut a = HashMap::new();
        a.insert(("orc".to_string(), "axe".to_string()), 30);
        let get = |id: &str| progres(DEFIS.iter().find(|d| d.id == id).unwrap(), &t, &a);
        assert_eq!(get("orc.ennemis"), 40);
        assert_eq!(get("orc.salles"), 100, "plafonné à l'objectif");
        assert_eq!(get("orc.hache"), 30);
        assert_eq!(get("orc.record"), 12);
        assert_eq!(get("knight.ennemis"), 0, "un autre héros ne compte pas");
    }
}
