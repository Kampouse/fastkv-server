FROM rust:1.84 AS builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN useradd -r -s /usr/sbin/nologin fastkv
COPY --from=builder /app/target/release/fastkv-server /usr/local/bin/
COPY --from=builder /app/static /app/static
WORKDIR /app
USER fastkv
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -f http://localhost:3001/health || exit 1
CMD ["fastkv-server"]
