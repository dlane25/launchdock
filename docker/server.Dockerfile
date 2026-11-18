FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server/ ./
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
ENV STORAGE_DIR=/data/storage PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:8080/healthz || exit 1
CMD ["node", "src/index.js"]
