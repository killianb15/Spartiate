# API des comptes (Rust). Construite par docker compose (voir ../docker-compose.yml).
FROM rust:1.93-slim-bookworm AS build
WORKDIR /src
# dépendances d'abord (mises en cache tant que Cargo.toml / Cargo.lock ne changent pas)
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release --locked && rm -rf src
COPY src src
COPY migrations migrations
RUN touch src/main.rs && cargo build --release --locked

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --no-create-home api
COPY --from=build /src/target/release/spartiate-api /usr/local/bin/spartiate-api
USER api
ENV ECOUTE=0.0.0.0:8124
EXPOSE 8124
ENTRYPOINT ["/usr/local/bin/spartiate-api"]
