# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:22-bookworm-slim
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS source-pack

ARG HANABICODE_VERSION

ENV ONNXRUNTIME_NODE_INSTALL=skip

WORKDIR /tmp/hanabicode-src
COPY . .

RUN set -eux; \
    if [ -n "${HANABICODE_VERSION:-}" ]; then \
      test "$(node -p "require('./package.json').version")" = "${HANABICODE_VERSION}"; \
    fi; \
    node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); delete pkg.scripts.prepare; fs.writeFileSync("package.json", `${JSON.stringify(pkg)}\n`);'; \
    npm ci

RUN set -eux; \
    mkdir -p /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/highlight --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/relay --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/protocol --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/client --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/plugin --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/server --pack-destination /tmp/paseo-packs; \
    npm pack --workspace=@getpaseo/cli --pack-destination /tmp/paseo-packs

FROM ${NODE_IMAGE}

ENV HOME=/home/hanabicode \
    PASEO_HOME=/home/hanabicode/.hanabicode \
    PASEO_LISTEN=0.0.0.0:6769 \
    PASEO_WEB_UI_ENABLED=true \
    PASEO_LOG_FORMAT=json \
    PASEO_LOG_LEVEL=info \
    CLAUDE_CONFIG_DIR=/home/hanabicode/.claude \
    CODEX_HOME=/home/hanabicode/.codex \
    XDG_CONFIG_HOME=/home/hanabicode/.config \
    XDG_DATA_HOME=/home/hanabicode/.local/share \
    XDG_STATE_HOME=/home/hanabicode/.local/state \
    XDG_CACHE_HOME=/home/hanabicode/.cache \
    ONNXRUNTIME_NODE_INSTALL=skip

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      gosu \
      lbzip2 \
      openssh-client \
      procps \
      tini; \
    rm -rf /var/lib/apt/lists/*

COPY --from=source-pack /tmp/hanabicode-packs /tmp/hanabicode-packs
RUN set -eux; \
	npm install -g /tmp/hanabicode-packs/*.tgz; \
    rm -rf /tmp/hanabicode-packs; \
    npm cache clean --force; \
    server_entry="$(npm root -g)/@getpaseo/server/dist/scripts/supervisor-entrypoint.js"; \
    test -f "$server_entry"; \
    printf '%s\n' "$server_entry" > /etc/hanabicode-server-entry; \
    node --check "$server_entry"

RUN set -eux; \
    existing_group="$(getent group 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_group" ] && [ "$existing_group" != "hanabicode" ]; then \
      groupmod --new-name hanabicode "$existing_group"; \
    elif [ -z "$existing_group" ]; then \
      groupadd --gid 1000 hanabicode; \
    fi; \
    existing_user="$(getent passwd 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_user" ] && [ "$existing_user" != "hanabicode" ]; then \
      usermod --login hanabicode --gid hanabicode --home /home/hanabicode --shell /bin/bash "$existing_user"; \
    elif [ -z "$existing_user" ]; then \
      useradd --uid 1000 --gid hanabicode --create-home --home-dir /home/hanabicode --shell /bin/bash hanabicode; \
    fi; \
    mkdir -p \
      /workspace \
      "$PASEO_HOME" \
      "$CLAUDE_CONFIG_DIR" \
      "$CODEX_HOME" \
      "$XDG_CONFIG_HOME" \
      "$XDG_DATA_HOME" \
      "$XDG_STATE_HOME" \
      "$XDG_CACHE_HOME"; \
    chown -R hanabicode:hanabicode /home/hanabicode /workspace

COPY docker/base/rootfs/ /
RUN chmod +x /usr/local/bin/hanabicode-docker-entrypoint

WORKDIR /workspace

EXPOSE 6769
VOLUME ["/home/hanabicode"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const listen=process.env.PASEO_LISTEN||'0.0.0.0:6769'; const m=listen.match(/:(\\d+)$/); const port=m?Number(m[1]):6769; require('http').get({hostname:'127.0.0.1',port,path:'/api/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/hanabicode-docker-entrypoint"]
