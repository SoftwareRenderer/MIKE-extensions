# A dev environment with Claude Code in it, for a MIKE sandboxed project.
#
#   docker build -t mike-claude-code \
#     --build-arg CLAUDE_CODE_VERSION=<the version you vetted> \
#     -f claude-code.Dockerfile .
#
# The version is a required build arg on purpose: a floating tag means a different agent program on
# every rebuild.
#
# Point a project's sandbox image at the result. The extension's mount and environment — Claude
# Code's config directory and HOME — come from the extension's own configuration, which is the only
# place they are declared; do not repeat them here.
#
# No USER line: this image runs as root, like every MIKE task container. The extension launches the
# CLI in dontAsk mode, which — unlike bypass mode — does not require a non-root user.

FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION
RUN test -n "$CLAUDE_CODE_VERSION" || { \
        echo "build with --build-arg CLAUDE_CODE_VERSION=<the version you vetted>" >&2; exit 1; \
    }

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global --omit=dev @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && npm cache clean --force

# MIKE runs the task in the worktree it mounts here, and git refuses to operate in a repository the
# process does not own unless told otherwise.
WORKDIR /workspace
RUN git config --system --add safe.directory '*'

# The login lives in the mounted config directory; nothing is written into the image.
CMD ["claude", "--help"]
