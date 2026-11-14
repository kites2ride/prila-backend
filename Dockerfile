# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN useradd --system --uid 10001 --create-home prila
COPY --from=build --chown=prila:prila /app/package.json /app/package-lock.json ./
COPY --from=build --chown=prila:prila /app/node_modules ./node_modules
COPY --from=build --chown=prila:prila /app/dist ./dist
USER prila
EXPOSE 4000
CMD ["node", "dist/index.js"]
