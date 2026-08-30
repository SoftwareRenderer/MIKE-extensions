# --- Stage 1: Install dependencies ---
FROM node:22-alpine AS builder

# Install pyright (provides the pyright-langserver entry point).
RUN npm install -g pyright


# --- Stage 2: Minimal Runtime Stage ---
FROM node:22-alpine

# No Python interpreter is installed on purpose: pyright analyses source
# statically and ships its own typeshed (stdlib + ~200 third-party stub
# packages) inside dist/, so an interpreter adds nothing here.
RUN apk add -U ca-certificates && update-ca-certificates

# Copy globally installed packages from builder
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy sandbox-bridge
COPY sandbox/sandbox-bridge /usr/local/bin/sandbox-bridge

RUN chmod +x /usr/local/bin/sandbox-bridge

# Set working directory
WORKDIR /workspace

# Expose bridge port
EXPOSE 9999

# Run sandbox-bridge
CMD ["/usr/local/bin/sandbox-bridge"]
