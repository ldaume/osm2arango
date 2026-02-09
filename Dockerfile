FROM oven/bun:1.3.8

RUN apt-get update \
  && apt-get install -y --no-install-recommends osmium-tool curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY bin ./bin

RUN bun install --frozen-lockfile --production

ENTRYPOINT ["bun", "run", "bin/osm2arango"]
