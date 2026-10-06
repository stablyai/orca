// Why: import this before the store modules — session hydration reaches for the preload API, which
// doesn't exist under vitest. Module stubs for sonner/runtime-graph/pty-transport live in the test
// files themselves so vitest can hoist them above the store imports.
const apiProxy = (): unknown =>
  new Proxy(() => undefined, {
    get: (_target, prop) => (prop === 'then' ? undefined : apiProxy()),
    apply: () => Promise.resolve(null)
  })

// @ts-expect-error -- mocked browser preload API
globalThis.window = { api: apiProxy() }
