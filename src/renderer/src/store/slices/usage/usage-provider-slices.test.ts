import { afterEach, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createClaudeUsageSlice } from './usage-provider-slices'
import type { AppState } from '../../types'

const scanState = {
  enabled: true,
  isScanning: false,
  lastScanStartedAt: null,
  lastScanCompletedAt: 1,
  lastScanError: null,
  hasAnyClaudeData: true
}
afterEach(() => vi.unstubAllGlobals())
it('keeps cached usage through disconnect, clears the spinner, and refetches after reconnect', async () => {
  let notify!: (connected: boolean) => void
  const getSnapshot = vi.fn(async () => ({
    scanState,
    summary: { turns: 1, inputTokens: 123 },
    daily: [],
    modelBreakdown: [],
    projectBreakdown: [],
    recentSessions: []
  }))
  vi.stubGlobal('window', {
    api: {
      claudeUsage: {
        onConnectionChanged: (listener: typeof notify) => {
          notify = listener
          return () => {}
        },
        getScanState: async () => scanState,
        getSnapshot,
        refresh: async () => scanState
      }
    }
  })
  const store = createStore<AppState>()(
    (...args) => ({ ...createClaudeUsageSlice(...args) }) as AppState
  )
  await store.getState().fetchClaudeUsage()
  store.setState({ claudeUsageScanState: { ...scanState, isScanning: true } })
  notify(false)
  expect(store.getState().claudeUsageScanState?.isScanning).toBe(false)
  expect(store.getState().claudeUsageSummary).toMatchObject({ inputTokens: 123 })
  getSnapshot.mockResolvedValue({
    ...(await getSnapshot()),
    summary: { turns: 2, inputTokens: 456 }
  })
  notify(true)
  await vi.waitFor(() =>
    expect(store.getState().claudeUsageSummary).toMatchObject({ inputTokens: 456 })
  )
})
