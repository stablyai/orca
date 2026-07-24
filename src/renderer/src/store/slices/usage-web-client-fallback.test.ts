import { create } from 'zustand'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { createClaudeUsageSlice } from './claude-usage'
import { createCodexUsageSlice } from './codex-usage'
import { createOpenCodeUsageSlice } from './opencode-usage'

// Regression: in the web client (paired `orca serve` runtime) the desktop-only
// usage IPC is not bridged, so the preload fallback proxy resolves every
// `window.api.<provider>Usage.*` call to `undefined`. Before the guards, the
// slices read `scanState.enabled` off that `undefined` and threw
// `TypeError: Cannot read properties of undefined (reading 'enabled')` when a
// user opened Settings -> Stats & Usage and pressed "enable" for an agent.
//
// These tests stub the web-client fallback (every call -> undefined) and assert
// the slices degrade to a no-op instead of throwing.

function stubWebClientFallback(): void {
  // Mirrors web-preload-api's createFallbackProxy: any method resolves to undefined.
  const undefinedAsync = vi.fn(() => Promise.resolve(undefined))
  const provider = {
    getScanState: undefinedAsync,
    setEnabled: undefinedAsync,
    getSnapshot: undefinedAsync,
    refresh: undefinedAsync,
    getSummary: undefinedAsync,
    getDaily: undefinedAsync,
    getBreakdown: undefinedAsync,
    getRecentSessions: undefinedAsync
  }
  vi.stubGlobal('window', {
    api: {
      claudeUsage: provider,
      codexUsage: provider,
      openCodeUsage: provider
    }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('usage slices in the web client (preload fallback -> undefined)', () => {
  it('claude: fetch and enable no-op without throwing', async () => {
    stubWebClientFallback()
    const store = create<AppState>()((...args) => createClaudeUsageSlice(...args) as AppState)
    await expect(store.getState().fetchClaudeUsage()).resolves.toBeUndefined()
    await expect(store.getState().enableClaudeUsage()).resolves.toBeUndefined()
    expect(store.getState().claudeUsageScanState).toBeNull()
    expect(store.getState().claudeUsageSummary).toBeNull()
  })

  it('codex: fetch and enable no-op without throwing', async () => {
    stubWebClientFallback()
    const store = create<AppState>()((...args) => createCodexUsageSlice(...args) as AppState)
    await expect(store.getState().fetchCodexUsage()).resolves.toBeUndefined()
    await expect(store.getState().enableCodexUsage()).resolves.toBeUndefined()
    expect(store.getState().codexUsageScanState).toBeNull()
    expect(store.getState().codexUsageSummary).toBeNull()
  })

  it('opencode: fetch and enable no-op without throwing', async () => {
    stubWebClientFallback()
    const store = create<AppState>()((...args) => createOpenCodeUsageSlice(...args) as AppState)
    await expect(store.getState().fetchOpenCodeUsage()).resolves.toBeUndefined()
    await expect(store.getState().enableOpenCodeUsage()).resolves.toBeUndefined()
    expect(store.getState().openCodeUsageScanState).toBeNull()
    expect(store.getState().openCodeUsageSummary).toBeNull()
  })
})
