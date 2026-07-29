# Single small image for the whole app — no build step (server is plain
# Node, client is plain JS/CSS/HTML), so this is just "copy files, npm ci".
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# No --env-file here: in production (App Runner) env vars are injected
# directly into the process, not read from a .env file. config.js reads
# process.env either way, so nothing else changes between local and prod.
ENV PORT=4173
EXPOSE 4173
CMD ["node", "server/index.js"]
