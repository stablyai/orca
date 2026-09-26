import { create } from 'zustand'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import {
  createClaudeUsageSlice,
  createCodexUsageSlice,
  createKimiUsageSlice,
  createMuseUsageSlice,
  createOpenCodeUsageSlice
} from './usage-provider-slices'

// Paired web clients resolve unbridged desktop usage calls to undefined.

function stubWebClientFallback(): void {
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
      openCodeUsage: provider,
      museUsage: provider,
      kimiUsage: provider
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

  it('muse: fetch and enable no-op without throwing', async () => {
    stubWebClientFallback()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test reads only this slice's own fields and actions.
    const store = create<AppState>()((...args) => createMuseUsageSlice(...args) as AppState)
    await expect(store.getState().fetchMuseUsage()).resolves.toBeUndefined()
    await expect(store.getState().enableMuseUsage()).resolves.toBeUndefined()
    expect(store.getState().museUsageScanState).toBeNull()
    expect(store.getState().museUsageSummary).toBeNull()
  })

  it('kimi: fetch and enable no-op without throwing', async () => {
    stubWebClientFallback()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test reads only this slice's own fields and actions.
    const store = create<AppState>()((...args) => createKimiUsageSlice(...args) as AppState)
    await expect(store.getState().fetchKimiUsage()).resolves.toBeUndefined()
    await expect(store.getState().enableKimiUsage()).resolves.toBeUndefined()
    expect(store.getState().kimiUsageScanState).toBeNull()
    expect(store.getState().kimiUsageSummary).toBeNull()
  })
})
