FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    ONBOARDING_HOST=0.0.0.0 \
    ONBOARDING_OUTPUT_ROOT=/var/lib/cpr-auth/data

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY requirements.txt ./
RUN python3 -m pip install --no-cache-dir --break-system-packages -r requirements.txt
COPY . .

RUN npm run build
RUN mkdir -p /var/lib/cpr-auth/data
EXPOSE 4399
CMD ["sh", "-c", "node src/console-server.mjs --host 0.0.0.0 --port ${PORT:-4399}"]
