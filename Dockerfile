FROM node:26-alpine

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
RUN mkdir -p /app/state && chown node:node /app/state

ENV HOST=127.0.0.1
EXPOSE 18787
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e 'fetch(`http://127.0.0.1:${process.env.PORT || 18787}/health`).then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))'
CMD ["node", "bin/instagram-cta.mjs", "start", "--dir", "/app"]
