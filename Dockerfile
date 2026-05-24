# Backend container — Azure Container Apps target.
# Single-stage because there's no build step (plain Node, no TS / bundler).

FROM node:20-alpine

WORKDIR /app

# Install production dependencies separately so layer caching survives
# code changes that don't touch package.json.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy the rest of the source. .dockerignore keeps node_modules, .env,
# data/, scripts/ etc. out of the image.
COPY . .

# Container Apps injects PORT — server.js reads it (see db.js / server.js).
# EXPOSE is documentation only; the platform doesn't use it.
EXPOSE 5000

# Drop root for runtime.
USER node

CMD ["node", "server.js"]
