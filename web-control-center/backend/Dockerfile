FROM node:20-alpine

WORKDIR /app

# Reproducible install: fails if the lockfile and package.json disagree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js auth.js audit.js coolify.js status.js hostinger.js history.js ./
COPY scripts ./scripts

# The audit trail is mounted here; the unprivileged user must own it.
RUN mkdir -p /var/lib/control-center && chown -R node:node /app /var/lib/control-center

USER node

ENV PORT=8787
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
