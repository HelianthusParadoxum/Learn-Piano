# syntax=docker/dockerfile:1
#
# Learn Piano: web app + Audiveris OMR (PDF → MusicXML) in one image.
#   docker compose up --build      →  http://localhost:8000
#
# Audiveris is built from source (official tag) so the image works on x86_64 and arm64 (Apple Silicon).

ARG AUDIVERIS_VERSION=5.11.0

# ---------- 1. Audiveris (optical music recognition) ----------
FROM eclipse-temurin:25-jdk-noble AS audiveris
ARG AUDIVERIS_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch "${AUDIVERIS_VERSION}" https://github.com/Audiveris/audiveris.git .
RUN ./gradlew --no-daemon --console=plain :app:installDist \
 && mkdir -p /opt/audiveris \
 && cp -r app/build/install/*/. /opt/audiveris/ \
 && launcher="$(find /opt/audiveris/bin -maxdepth 1 -type f ! -name '*.bat' | head -n 1)" \
 && test -n "$launcher" \
 && chmod +x "$launcher" \
 && ln -s "$launcher" /opt/audiveris/audiveris \
 && ls -la /opt/audiveris/bin

# ---------- 2. Web app ----------
FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY scripts ./scripts
COPY web ./web
RUN npm run build

# ---------- 3. Runtime ----------
FROM eclipse-temurin:25-jre-noble
ARG AUDIVERIS_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tesseract-ocr-eng tesseract-ocr-rus tesseract-ocr-deu tesseract-ocr-ita \
      fontconfig fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 app \
 && mkdir -p /data && chown app:app /data
COPY --from=web /usr/local/bin/node /usr/local/bin/node
COPY --from=audiveris /opt/audiveris /opt/audiveris
WORKDIR /app
COPY server/server.mjs ./server/server.mjs
COPY --from=web /app/dist ./dist

ENV NODE_ENV=production \
    PORT=8000 \
    DATA_DIR=/data \
    AUDIVERIS_CMD=/opt/audiveris/audiveris \
    AUDIVERIS_VERSION=${AUDIVERIS_VERSION} \
    AUDIVERIS_JAVA_OPTIONS="-Djava.awt.headless=true -Xmx3g" \
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata

USER app
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/server.mjs"]
