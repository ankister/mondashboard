FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends smartmontools ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /agent
COPY agent.js ./
ENV HD_HOST_ROOT=/host NODE_ENV=production
CMD ["node", "agent.js"]
