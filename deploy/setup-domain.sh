#!/usr/bin/env bash
# À lancer UNE SEULE FOIS depuis ta machine :
#   ssh ubuntu@51.210.150.192 'bash -s' < deploy/setup-domain.sh
# Ajoute combat.gashrod.lol au nginx Docker partagé (wc-predictor) avec un
# certificat Let's Encrypt, et proxifie vers le service spartiate (:8123, WebSocket inclus).
set -euo pipefail

DOMAIN=combat.gashrod.lol
SITE=/home/ubuntu/sites/wc-predictor
CONF=$SITE/nginx/nginx.conf
CERTBOT_CONF=/home/ubuntu/porno/worldcup-predictor/certbot/conf
CERTBOT_WWW=/home/ubuntu/porno/worldcup-predictor/certbot/www

if grep -q "server_name $DOMAIN" "$CONF"; then
  echo "$DOMAIN est déjà dans nginx.conf, rien à faire."; exit 0
fi

reload_or_restore() {
  if sudo docker exec wc-predictor-nginx-1 nginx -t; then
    sudo docker exec wc-predictor-nginx-1 nginx -s reload
  else
    cp "$CONF.bak-avant-combat" "$CONF"; echo "Config invalide, sauvegarde restaurée."; exit 1
  fi
}

cp "$CONF" "$CONF.bak-avant-combat"

# 1) bloc HTTP (challenge ACME + redirection)
cat >> "$CONF" <<EOF

# --- combat (Spartiate Arènes, service systemd spartiate :8123) ---
server {
    listen 80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF
reload_or_restore

# 2) certificat
sudo docker run --rm \
  -v "$CERTBOT_CONF":/etc/letsencrypt -v "$CERTBOT_WWW":/var/www/certbot \
  certbot/certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" \
  --non-interactive --agree-tos --register-unsafely-without-email

# 3) bloc HTTPS (proxy + WebSocket)
cat >> "$CONF" <<EOF

server {
    listen 443 ssl;
    http2 on;
    server_name $DOMAIN;

    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;

    add_header Strict-Transport-Security "max-age=31536000" always;

    location / {
        proxy_pass http://host.docker.internal:8123;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
EOF
reload_or_restore
echo "OK : https://$DOMAIN"
