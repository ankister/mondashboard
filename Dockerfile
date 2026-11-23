FROM node:22-alpine
RUN apk add --no-cache tzdata su-exec
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY agent ./agent
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data
ENV NODE_ENV=production DATA_DIR=/data PORT=3080 TZ=Europe/Paris PUID=1000 PGID=1000
VOLUME /data
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3080/api/session > /dev/null || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
