FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

#   clangd           -> /usr/bin/clangd (metapackage -> clangd-18)
#   libc6-dev        -> C standard headers; depends on linux-libc-dev, which
#                       provides /usr/include/linux/*.h
#   libstdc++-13-dev -> the C++ standard headers (/usr/include/c++/13 plus the
#                       arch dir holding bits/c++config.h) and, via
#                       libgcc-13-dev, the GCC installation directory
#                       /usr/lib/gcc/*/13/ (with crtbegin.o). That directory is
#                       what clang scans to discover the system libstdc++
#                       version and its include paths — without it
#                       `#include <vector>` fails.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        clangd \
        libc6-dev \
        linux-libc-dev \
        libstdc++-13-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# clangd scratch space
RUN mkdir -p /var/cache/clangd && chmod 1777 /var/cache/clangd

# Fail the build early if clangd is not on PATH.
RUN clangd --version

COPY sandbox/sandbox-bridge /usr/local/bin/sandbox-bridge
RUN chmod +x /usr/local/bin/sandbox-bridge

WORKDIR /workspace

EXPOSE 9999

CMD ["/usr/local/bin/sandbox-bridge"]
