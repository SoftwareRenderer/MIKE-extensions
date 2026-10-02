// The adapter is a module of its own, beside the wasm it is the source for. It
// imports core's pkg/agent for the event and config types, which is the only
// reason a module is needed: build.sh runs `go build` in wasm/, and a module root
// here is what makes that a build rather than an error.
module mike/extensions/agent/pi

go 1.26.2

require mike v0.0.0

// A directory replace, so no go.sum entry and no version: the sibling-checkout
// layout is the one MIKE's own scripts assume (MIKE reads its extension source at
// ../MIKE-extensions). Override the path for a different layout.
replace mike => ../../../MIKE
