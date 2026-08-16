# Running HanabiCode in Docker

HanabiCode publishes a container image for running the daemon on a server, VM,
NAS, or homelab box. The image also serves the bundled browser web UI, so one
container gives you both the daemon API and a self-hosted UI.

The image is a fork of the AGPL-licensed Paseo daemon image; upstream copyright
and license notices are retained. The image source lives in
[`docker/`](../docker/).

## How it works

The image:

- builds the server and CLI workspaces from source-built tarballs (their
  internal `@getpaseo/*` package names are compatibility internals, not
  publish targets)
- runs the daemon as the non-root `hanabicode` user
- listens on `0.0.0.0:6769` inside the container
- enables the bundled daemon web UI with `PASEO_WEB_UI_ENABLED=true`
- stores daemon state and agent credentials under `/home/hanabicode`
- leaves agent CLIs out of the base image

The inherited `PASEO_*` environment prefix is deliberate — the daemon's
configuration surface is unchanged. The container identity is HanabiCode's.

Open the container's HTTP origin, for example `http://localhost:6769`, to load
the web UI. The served app receives a same-origin connection hint and connects
back to that daemon. Static UI files load without daemon auth; API and
WebSocket requests still require `PASEO_PASSWORD` when one is configured.

## Quick Start

```bash
docker run -d --name hanabicode \
  -p 6769:6769 \
  -e PASEO_PASSWORD=change-me \
  -v "$PWD/hanabicode-home:/home/hanabicode" \
  -v "$PWD:/workspace" \
  ghcr.io/dey11/hanabicode:latest
```

Then open:

```text
http://localhost:6769
```

If you set `PASEO_PASSWORD`, enter the same password when adding the direct
daemon connection in the web UI or another HanabiCode client.

## Docker Compose

Use [`docker/docker-compose.example.yml`](../docker/docker-compose.example.yml):

```bash
cp docker/docker-compose.example.yml docker-compose.yml
$EDITOR docker-compose.yml
docker compose up -d
```

Minimal example:

```yaml
services:
  hanabicode:
    image: ghcr.io/dey11/hanabicode:latest
    restart: unless-stopped
    ports:
      - "6769:6769"
    environment:
      PASEO_PASSWORD: "change-me"
    volumes:
      - ./hanabicode-home:/home/hanabicode
      - ./workspace:/workspace
```

## Installing Agents

The base image does not preinstall Claude Code, Codex, OpenCode, Copilot, Pi, or
other agent CLIs. That keeps the default image small and avoids coupling
HanabiCode releases to third-party agent release cycles.

Create a child image for the agents you use:

```Dockerfile
FROM ghcr.io/dey11/hanabicode:latest

USER root
RUN npm install -g @openai/codex @anthropic-ai/claude-code opencode-ai
```

Build it:

```bash
docker build -f Dockerfile -t hanabicode-with-agents .
```

Then use `image: hanabicode-with-agents` in Compose.

Leave the child image user as root. The base entrypoint uses root only for
first-run directory setup, then drops the daemon and launched agents to the
non-root `hanabicode` user.

An example child image is in
[`docker/Dockerfile.agents.example`](../docker/Dockerfile.agents.example).

You can also mount credentials from the host or run agent login once inside the
container:

```bash
docker exec -it --user hanabicode hanabicode codex
docker exec -it --user hanabicode hanabicode claude
```

Agent credentials and config persist in `/home/hanabicode`, alongside daemon
state. Provider environment variables such as `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `OPENAI_BASE_URL`, or `ANTHROPIC_BASE_URL` can be passed
through `docker run -e` or `compose.environment`; the daemon passes them to
launched agents.

## Volumes

| Mount              | Purpose                                                                            |
| ------------------ | ---------------------------------------------------------------------------------- |
| `/home/hanabicode` | HanabiCode state under `.hanabicode` plus agent config such as `.codex`, `.claude` |
| `/workspace`       | Code that HanabiCode and launched agents can read and write                        |

The image defaults:

| Variable       | Default                        |
| -------------- | ------------------------------ |
| `HOME`         | `/home/hanabicode`             |
| `PASEO_HOME`   | `/home/hanabicode/.hanabicode` |
| `PASEO_LISTEN` | `0.0.0.0:6769`                 |

If you bind-mount host directories on Linux, make sure the container user can
write them. The built-in `hanabicode` user has uid/gid `1000:1000`. For a
different host uid/gid, either adjust ownership on the mounted directories or
run the container with Docker's `--user` / Compose `user:` option.

## Reverse Proxies

When serving HanabiCode behind a reverse proxy, forward normal HTTP requests
and WebSocket upgrades to the same daemon port.

Caddy example:

```caddy
hanabicode.example.com {
  reverse_proxy 127.0.0.1:6769
}
```

Nginx example:

```nginx
server {
    listen 443 ssl;
    server_name hanabicode.example.com;

    location / {
        proxy_pass http://127.0.0.1:6769;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

If you reach the daemon by DNS name, set `PASEO_HOSTNAMES` so host-header
validation allows that name:

```yaml
environment:
  PASEO_HOSTNAMES: "hanabicode.example.com,.lan"
```

IPs and `localhost` are allowed by default.

## Security

- Set `PASEO_PASSWORD` for any published port or network-reachable deployment.
- Prefer HTTPS at the reverse proxy for direct browser access.
- Use the fork-owned HanabiCode relay for untrusted networks or mobile access
  when you do not want to expose the daemon port directly. See
  [docs/fork-docs/relay-options.md](fork-docs/relay-options.md).
- The container is the isolation boundary for agents. Agents can read and write
  whatever you mount into `/workspace` and whatever credentials you place in
  `/home/hanabicode`.
- The bundled web UI static files are public on the daemon origin. The daemon
  API and WebSocket remain protected by password auth when configured.

See [SECURITY.md](../SECURITY.md) for the daemon trust model.

## Building Locally

```bash
docker build -f docker/base/Dockerfile -t hanabicode:local .
```

To assert the source tree version while building:

```bash
docker build \
  --build-arg HANABICODE_VERSION=0.4.0 \
  -t hanabicode:0.4.0 \
  -f docker/base/Dockerfile \
  .
```

The Docker workflow (`docker.yml`) builds the image on pull requests and on
`main` as a non-publishing check. Manual publishes require an explicit
`hanabicode_version`:

```bash
gh workflow run docker.yml \
  --ref main \
  -f hanabicode_version=0.4.0 \
  -f publish=true
```

The workflow builds from the checked-out source tree and publishes to this
repository's GHCR namespace (`ghcr.io/dey11/hanabicode`). Prerelease versions
publish only the exact version tag; `publish_latest=true` adds `latest` for
non-prerelease versions.

The published image is multi-arch for `linux/amd64` and `linux/arm64`.

## Troubleshooting

- **The web UI loads but cannot connect**: if `PASEO_PASSWORD` is set, add a
  direct connection with the same password.
- **403 Host not allowed**: set `PASEO_HOSTNAMES` to the DNS names you use.
- **Provider not available**: install that agent CLI in a child image or mount
  a runtime where the binary is on `PATH`.
- **Permission errors in `/workspace`**: make the mounted directory writable by
  uid/gid `1000:1000`, or run the container as the host uid/gid.
- **Logs**: inspect `docker logs hanabicode` or
  `/home/hanabicode/.hanabicode/daemon.log` inside the container.
