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
COPY packages/shared packages/shared
COPY packages/indicators packages/indicators
COPY web web
RUN npm run build -w web

FROM nginx:1.27-alpine
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
