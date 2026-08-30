FROM rust:1-slim-bookworm

# rust-analyzer: the language server itself.
# clippy: check-on-save engine (see manifest check.command).
# rust-src: standard library sources, so go-to-definition/hover reach std and core.
# Installed through rustup rather than as a standalone release so the server's
# version always matches the toolchain it analyses — a mismatched rust-analyzer
# fails to parse newer stdlib syntax.
RUN rustup component add rust-analyzer clippy rust-src

# Writable scratch for cargo build artifacts. Mounted project trees are read-only,
# so CARGO_TARGET_DIR must live in the container's own filesystem (manifest envs).
RUN mkdir -p /tmp/cargo-target

# Copy sandbox-bridge
COPY sandbox/sandbox-bridge /usr/local/bin/sandbox-bridge

RUN chmod +x /usr/local/bin/sandbox-bridge

# Set working directory
WORKDIR /workspace

# Expose bridge port
EXPOSE 9999

# Run sandbox-bridge
CMD ["/usr/local/bin/sandbox-bridge"]
