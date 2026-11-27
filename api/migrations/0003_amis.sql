-- Amis : une demande (de -> vers) devient une amitié quand le destinataire l'accepte.
-- Une seule ligne par paire (dans un sens ou dans l'autre : vérifié par l'API).
CREATE TABLE amis (
  de        BIGINT NOT NULL REFERENCES joueurs(id) ON DELETE CASCADE,
  vers      BIGINT NOT NULL REFERENCES joueurs(id) ON DELETE CASCADE,
  accepte   BOOLEAN NOT NULL DEFAULT false,
  cree_le   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (de, vers),
  CHECK (de <> vers)
);
CREATE INDEX amis_vers ON amis (vers);
-- classement : meilleure partie de chaque joueur (héros, arme) retrouvée vite
CREATE INDEX parties_joueur_salle ON parties (joueur, salle DESC, jouee_le);
