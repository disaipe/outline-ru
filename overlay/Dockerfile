# syntax=docker/dockerfile:1
#
# Self-contained image for outline-ru.
#
# Unlike upstream's Dockerfile (which splits deps and runner and pulls the
# deps artifact from the public outlinewiki/outline-base image), this one
# does both stages in one go — so our overlay patches and ru_RU/translation.json
# actually end up in the final image.
#
# Structure mirrors upstream's Dockerfile.base + Dockerfile combined, with
# the single tweak: COPY --from=base → COPY --from=deps (no public base).
#
# Build context = a clone of outline/outline at the pinned UPSTREAM_SHA,
# with our overlay applied (see scripts/build.sh --skip-build).

ARG APP_PATH=/opt/outline

# ========== Stage 1: deps — compile Outline with overlay patches ==========
FROM node:24.14.1 AS deps

ARG APP_PATH
WORKDIR $APP_PATH

COPY ./package.json ./yarn.lock ./.yarnrc.yml ./
COPY ./patches ./patches

RUN apt-get update && \
    apt-get install -y cmake && \
    rm -rf /var/lib/apt/lists/*
ENV NODE_OPTIONS="--max-old-space-size=24000"

RUN corepack enable
RUN yarn install --immutable --network-timeout 1000000 && \
    yarn cache clean

COPY . .
ARG CDN_URL
RUN yarn build

RUN yarn workspaces focus --production && \
    yarn cache clean

# ========== Stage 2: runner — slim image with only runtime artifacts ==========
FROM node:24.14.1-slim AS runner

LABEL org.opencontainers.image.source="https://github.com/outline/outline"

ARG APP_PATH
WORKDIR $APP_PATH
ENV NODE_ENV=production

RUN addgroup --gid 1001 nodejs && \
    adduser --uid 1001 --ingroup nodejs nodejs && \
    mkdir -p /var/lib/outline && \
    chown -R nodejs:nodejs /var/lib/outline && \
    chown -R nodejs:nodejs $APP_PATH

COPY --from=deps --chown=nodejs:nodejs $APP_PATH/build ./build
COPY --from=deps --chown=nodejs:nodejs $APP_PATH/server ./server
COPY --from=deps --chown=nodejs:nodejs $APP_PATH/public ./public
COPY --from=deps --chown=nodejs:nodejs $APP_PATH/.sequelizerc ./.sequelizerc
COPY --from=deps --chown=nodejs:nodejs $APP_PATH/node_modules ./node_modules
COPY --from=deps --chown=nodejs:nodejs $APP_PATH/package.json ./package.json

RUN apt-get update && \
    apt-get install -y wget && \
    rm -rf /var/lib/apt/lists/*

ENV FILE_STORAGE_LOCAL_ROOT_DIR=/var/lib/outline/data
RUN mkdir -p "$FILE_STORAGE_LOCAL_ROOT_DIR" && \
    chown -R nodejs:nodejs "$FILE_STORAGE_LOCAL_ROOT_DIR" && \
    chmod 1777 "$FILE_STORAGE_LOCAL_ROOT_DIR"

VOLUME /var/lib/outline/data

USER nodejs

HEALTHCHECK --interval=1m CMD wget -qO- "http://localhost:${PORT:-3000}/_health" | grep -q "OK" || exit 1

EXPOSE 3000
CMD ["node", "build/server/index.js"]
