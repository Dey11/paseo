# Docker status

HanabiCode does not publish or support a container image. The release workflow builds a self-contained Linux ARM64 archive with a bundled Node runtime. Install it with the [native VPS daemon guide](fork-docs/native-daemon.md).

The inherited [`docker/`](../docker/) source remains available for upstream syncs and local experiments. No GitHub workflow builds it, no HanabiCode tag publishes it, and the project does not maintain a GHCR package. Changes to that source do not belong in the HanabiCode release path unless the deployment decision is revisited explicitly.
