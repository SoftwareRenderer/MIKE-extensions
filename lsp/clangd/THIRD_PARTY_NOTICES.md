# Third-Party Notices — C/C++ Language Server

This extension's own content (`manifest.json`, `Dockerfile`) is licensed under
Apache-2.0 (see `LICENSE`). It contains no compiled code: it tells MIKE which
language server to launch and how to build the image that runs it. Every program
and header set assembled into that image keeps its own license and copyright.

Full license texts are present in the built image under
`/usr/share/doc/<package>/copyright` (the Dockerfile removes apt's lists, not its
doc directory).

## Language server

| Software | License | Source |
|----------|---------|--------|
| clangd (LLVM/clang subproject) | Apache-2.0 WITH LLVM-exception | https://clangd.llvm.org/ — https://llvm.org/LICENSE.txt (see manifest `license_url`) |
| LLVM core / clang libraries (`libllvm18`, `libclang-cpp18`, `libclang-common-18-dev`) | Apache-2.0 WITH LLVM-exception | https://github.com/llvm/llvm-project |
| gRPC (`libgrpc29t64`, `libgrpc++1.51t64` — pulled in by clangd's optional remote-index support) | Apache-2.0 | https://github.com/grpc/grpc |
| abseil-cpp (`libabsl20220623t64`, dependency of gRPC) | Apache-2.0 | https://github.com/abseil/abseil-cpp |

## Base image and system headers

The image installs no compiler, linker or build tool — only clangd plus the
system header sets it resolves `#include <...>` against. They are read as data
during analysis; nothing from them is linked into MIKE, and nothing from them is
copied into a user's project.

| Software | Package(s) | License |
|----------|-----------|---------|
| Ubuntu base image | `ubuntu:24.04` | each constituent package keeps its own license |
| GNU C Library (glibc) headers | `libc6-dev`, `libc6`, `libc-dev-bin` | LGPL-2.1-or-later (the `libc6` runtime exception permits use by any program) |
| GCC C++ standard library headers | `libstdc++-13-dev`, `libstdc++6` | GPL-3.0-or-later **WITH** GCC-Runtime-Library-Exception-3.1 — the exception exists precisely to allow code to use these headers/libraries without taking on the GPL |
| GCC support library headers | `libgcc-13-dev`, `libgcc-s1` (and its sanitizer runtime deps) | GPL-2.0-or-later **WITH** GCC-Runtime-Library-Exception-2.0 |
| Linux kernel UAPI headers | `linux-libc-dev` | GPL-2.0-only **WITH** Linux-syscall-note — the note is what makes including these headers in userspace code non-viral |
| Other transitive packages (`libcrypt-dev`, `rpcsvc-proto`, `debconf`, `gcc-13-base`, …) | — | each keeps its own license; see `/usr/share/doc/<package>/copyright` in the image |

## MIKE

The `sandbox-bridge` binary copied into the image is MIKE's own component
(Apache-2.0); see the repository root `NOTICE` and `THIRD_PARTY_NOTICES.md`.
