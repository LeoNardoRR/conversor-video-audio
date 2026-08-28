FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG VITE_CONVERSION_MODE=server
ARG VITE_MAX_UPLOAD_GB=12
ARG VITE_RETENTION_HOURS=6
ENV VITE_CONVERSION_MODE=$VITE_CONVERSION_MODE \
    VITE_MAX_UPLOAD_GB=$VITE_MAX_UPLOAD_GB \
    VITE_RETENTION_HOURS=$VITE_RETENTION_HOURS

RUN npm run build

FROM caddy:2.10-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv

EXPOSE 80 443 443/udp
