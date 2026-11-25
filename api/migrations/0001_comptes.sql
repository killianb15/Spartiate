-- Comptes des joueurs. Ne jamais modifier une migration déjà passée : en ajouter une nouvelle
-- (0002_amis.sql, 0003_guildes.sql…), sqlx les applique dans l'ordre au démarrage de l'API.
CREATE TABLE joueurs (
  id        BIGSERIAL PRIMARY KEY,
  pseudo    TEXT NOT NULL,
  mdp       TEXT NOT NULL,                       -- Argon2id, format PHC ($argon2id$v=19$...)
  cree_le   TIMESTAMPTZ NOT NULL DEFAULT now(),
  parties   INTEGER NOT NULL DEFAULT 0,          -- donjons terminés
  record    INTEGER NOT NULL DEFAULT 0,          -- meilleure salle atteinte
  ennemis   INTEGER NOT NULL DEFAULT 0,
  boss      INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX joueurs_pseudo ON joueurs (lower(pseudo));

CREATE TABLE sessions (
  jeton     TEXT PRIMARY KEY,                    -- empreinte SHA-256 du jeton (le jeton n'est jamais stocké)
  joueur    BIGINT NOT NULL REFERENCES joueurs(id) ON DELETE CASCADE,
  expire_le TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_joueur ON sessions (joueur);

CREATE TABLE parties (
  id        BIGSERIAL PRIMARY KEY,
  joueur    BIGINT NOT NULL REFERENCES joueurs(id) ON DELETE CASCADE,
  salle     INTEGER NOT NULL,
  ennemis   INTEGER NOT NULL,
  boss      INTEGER NOT NULL,
  en_ligne  BOOLEAN NOT NULL,
  jouee_le  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX parties_joueur ON parties (joueur, jouee_le DESC);
