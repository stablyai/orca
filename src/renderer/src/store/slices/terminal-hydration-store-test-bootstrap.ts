import { vi } from 'vitest'

// Why: import this before the store modules — session hydration reaches for the preload API and the
// runtime/PTY singletons, which don't exist under vitest.
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
vi.mock('@/components/terminal-pane/pty-transport', () => ({
  registerEagerPtyBuffer: vi.fn(),
  ensurePtyDispatcher: vi.fn()
}))

const apiProxy = (): unknown =>
  new Proxy(() => undefined, {
    get: (_target, prop) => (prop === 'then' ? undefined : apiProxy()),
    apply: () => Promise.resolve(null)
  })

// @ts-expect-error -- mocked browser preload API
globalThis.window = { api: apiProxy() }
