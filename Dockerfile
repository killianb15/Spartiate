# Serveur du jeu (fichiers du jeu, salons en WebSocket, relais /api vers l'API des comptes).
# Construit par docker compose (voir docker-compose.yml) ; bibliothèque standard de Python seulement.
FROM python:3.13-alpine
WORKDIR /app
RUN adduser -D -H -u 10002 jeu
# seulement ce que sert le jeu (voir .dockerignore : ni l'API, ni les tests, ni les outils, ni .git/.env)
COPY . .
USER jeu
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 8123
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8123/index.html', timeout=2)"
ENTRYPOINT ["python", "serveur.py", "8123", "--no-browser"]
