# HanabiCode Docker Image

This directory contains the HanabiCode daemon image, a modified downstream fork of Paseo.

The image runs the daemon headless and serves the bundled web UI from the same
HTTP origin. Start it, then open the daemon URL in a browser.

```bash
docker run -d --name hanabicode \
  -p 6769:6769 \
  -e PASEO_PASSWORD=change-me \
  -v "$PWD/hanabicode-home:/home/hanabicode" \
  -v "$PWD:/workspace" \
  ghcr.io/dey11/hanabicode:latest
```

Then open `http://localhost:6769`.

The base image intentionally does not bundle agent CLIs. Extend it with the
agents you use:

```Dockerfile
FROM ghcr.io/dey11/hanabicode:latest

USER root
RUN npm install -g @openai/codex @anthropic-ai/claude-code
```

See [docs/docker.md](../docs/docker.md) for Compose, reverse proxy, security,
agent auth, and troubleshooting notes.
