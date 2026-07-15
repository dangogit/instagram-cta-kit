FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV HOST=0.0.0.0
EXPOSE 18787
CMD ["node", "bin/instagram-cta.mjs", "start", "--dir", "/app"]
