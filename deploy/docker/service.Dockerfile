# Builds one backend service: docker build --build-arg SERVICE=ws-gateway -f deploy/docker/service.Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/data-providers/package.json packages/data-providers/
COPY packages/candle-aggregator/package.json packages/candle-aggregator/
COPY packages/service-kit/package.json packages/service-kit/
COPY packages/indicators/package.json packages/indicators/
COPY packages/alert-engine/package.json packages/alert-engine/
COPY services/ingest/package.json services/ingest/
COPY services/ws-gateway/package.json services/ws-gateway/
COPY services/api/package.json services/api/
COPY services/alerts/package.json services/alerts/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund --ignore-scripts && npm rebuild esbuild
COPY packages packages
COPY services services
COPY scripts scripts
ARG SERVICE
RUN test -n "$SERVICE" && cd services/$SERVICE && BUNDLE_DEPS=1 node ../../scripts/build-service.mjs

FROM node:22-alpine
ARG SERVICE
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/services/${SERVICE}/dist ./dist
USER node
CMD ["node", "--enable-source-maps", "dist/index.js"]
