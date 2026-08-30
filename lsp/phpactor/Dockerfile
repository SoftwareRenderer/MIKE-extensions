# --- Stage 1: Install and verify the toolchain ---
FROM php:8.5-cli-alpine AS builder

RUN apk add -U curl ca-certificates oniguruma-dev linux-headers

# Phpactor's own requirements: ext-mbstring, ext-posix (ext-tokenizer ships enabled).
# The compile log is redirected so only a failure excerpt reaches the build output.
RUN docker-php-ext-install mbstring posix > /tmp/ext-install.log 2>&1 \
    || { tail -n 30 /tmp/ext-install.log; exit 1; } \
 && php -m | grep -qx mbstring \
 && php -m | grep -qx posix \
 && php -m | grep -qx tokenizer

RUN curl -fsSL -o /usr/local/lib/phpactor.phar \
      "https://github.com/phpactor/phpactor/releases/latest/download/phpactor.phar" \
 && php -r 'new Phar("/usr/local/lib/phpactor.phar");' \
 && printf '#!/bin/sh\nexec php /usr/local/lib/phpactor.phar "$@"\n' > /usr/local/bin/phpactor \
 && chmod +x /usr/local/bin/phpactor \
 && phpactor --version \
 && phpactor language-server --help > /dev/null


# --- Stage 2: Minimal Runtime Stage ---
FROM php:8.5-cli-alpine

# Copy certificates for HTTPS requests made by phpactor/bridge
RUN apk add -U ca-certificates && update-ca-certificates

# Compiled extensions (mbstring, posix) + their ini files
COPY --from=builder /usr/local/lib/php/extensions /usr/local/lib/php/extensions
COPY --from=builder /usr/local/etc/php/conf.d /usr/local/etc/php/conf.d

# Phpactor PHAR and its launcher
COPY --from=builder /usr/local/lib/phpactor.phar /usr/local/lib/phpactor.phar
COPY --from=builder /usr/local/bin/phpactor /usr/local/bin/phpactor

# Writable HOME: phpactor writes its config, container cache and index here.
# The sandbox runs with no host environment, so this must not default to /.
ENV HOME=/var/cache/phpactor
RUN mkdir -p /var/cache/phpactor && chmod 1777 /var/cache/phpactor

# Copy sandbox-bridge
COPY sandbox/sandbox-bridge /usr/local/bin/sandbox-bridge

RUN chmod +x /usr/local/bin/sandbox-bridge

# Set working directory
WORKDIR /workspace

# Expose bridge port
EXPOSE 9999

# Run sandbox-bridge
CMD ["/usr/local/bin/sandbox-bridge"]
