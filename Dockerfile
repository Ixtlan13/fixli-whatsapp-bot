FROM node:20-bookworm-slim

WORKDIR /app

# Install git and essential build tools required by Baileys dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
ENV PORT=3000

CMD ["node", "server.js"]
