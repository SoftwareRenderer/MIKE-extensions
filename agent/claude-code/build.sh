#!/usr/bin/env bash
# Build the Claude Code agent adapter as a WASI reactor module.
#
# The WASM module uses the wazero allocation/tinygo/greet.go memory model:
#   - Host calls Alloc(size) → writes data → calls function with string params → Free(ptr)
#   - WASM calls store_result(data string) callback for WASM→host results
#   - Go maps `string` params to (i32 ptr, i32 len) automatically
#
# Requires Go 1.24+ with wasip1 and c-shared support.
set -euo pipefail

cd "$(dirname "$0")/wasm"

# Verify Go version (wasip1 needs Go 1.21+; c-shared WASI needs 1.24+)
if ! command -v go &>/dev/null; then
    echo "Error: Go is not installed" >&2
    exit 1
fi

echo "Building claude-code.wasm..."
GOOS=wasip1 GOARCH=wasm go build -trimpath -buildmode=c-shared -o ../claude-code.wasm .

if [ ! -f ../claude-code.wasm ]; then
    echo "Error: claude-code.wasm was not built" >&2
    exit 1
fi

echo "Built claude-code.wasm ($(ls -lh ../claude-code.wasm | awk '{print $5}'))"
