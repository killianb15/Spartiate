-- Défis des héros : chaque partie retient le héros et l'arme du joueur (ennemis = ses propres victimes),
-- la progression se calcule sur ces parties ; un défi accompli est gardé avec sa date.
ALTER TABLE parties ADD COLUMN heros TEXT, ADD COLUMN arme TEXT;
CREATE INDEX parties_joueur_heros ON parties (joueur, heros);

CREATE TABLE defis_reussis (
  joueur    BIGINT NOT NULL REFERENCES joueurs(id) ON DELETE CASCADE,
  defi      TEXT NOT NULL,                       -- identifiant de defis.rs (ex. 'orc.hache')
  reussi_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (joueur, defi)
);
