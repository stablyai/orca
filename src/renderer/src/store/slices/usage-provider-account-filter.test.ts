import { create } from 'zustand'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexUsageScanState,
  CodexUsageSnapshot,
  CodexUsageSummary
} from '../../../../shared/codex-usage-types'
import type { AppState } from '../types'
import { createCodexUsageSlice } from './usage-provider-slices'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

async function flushImmediatePromises(): Promise<void> {
  for (let index = 0; index < 5; index++) {
    await Promise.resolve()
  }
}

function createScanState(): CodexUsageScanState {
  return {
    enabled: true,
    isScanning: false,
    lastScanStartedAt: 100,
    lastScanCompletedAt: 200,
    lastScanError: null,
    hasAnyCodexData: true
  }
}

function createSummary(totalTokens: number): CodexUsageSummary {
  return {
    scope: 'orca',
    range: '30d',
    sessions: 1,
    events: 1,
    inputTokens: totalTokens / 2,
    cachedInputTokens: 0,
    outputTokens: totalTokens / 2,
    reasoningOutputTokens: 0,
    totalTokens,
    estimatedCostUsd: 1,
    topModel: 'gpt-5',
    topProject: 'orca',
    hasAnyCodexData: true
  }
}

function createSnapshot(totalTokens: number): CodexUsageSnapshot {
  return {
    scanState: createScanState(),
    accountOptions: [
      { kind: 'managed', accountId: 'account-a', workspaceLabel: 'A', deleted: false },
      { kind: 'managed', accountId: 'account-b', workspaceLabel: 'B', deleted: false }
    ],
    summary: createSummary(totalTokens),
    daily: [],
    modelBreakdown: [],
    projectBreakdown: [],
    recentSessions: []
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Codex usage account filter fetches', () => {
  it('discards a slower first filter when a later filter finishes first', async () => {
    const snapshotCalls: Deferred<CodexUsageSnapshot>[] = []
    const getSnapshot = vi.fn(() => {
      const deferred = createDeferred<CodexUsageSnapshot>()
      snapshotCalls.push(deferred)
      return deferred.promise
    })

    vi.stubGlobal('window', {
      api: {
        codexUsage: {
          getScanState: vi.fn(() => Promise.resolve(createScanState())),
          getSnapshot,
          refresh: vi.fn(() => Promise.resolve(createScanState())),
          setEnabled: vi.fn(),
          getSummary: vi.fn(),
          getDaily: vi.fn(),
          getBreakdown: vi.fn(),
          getRecentSessions: vi.fn()
        }
      }
    })

    const store = create<AppState>()((...args) => createCodexUsageSlice(...args) as AppState)
    const first = store.getState().setCodexUsageAccountFilter({
      kind: 'managed',
      accountId: 'account-a'
    })
    await flushImmediatePromises()
    expect(snapshotCalls).toHaveLength(1)

    const second = store.getState().setCodexUsageAccountFilter({
      kind: 'managed',
      accountId: 'account-b'
    })
    await flushImmediatePromises()
    expect(snapshotCalls).toHaveLength(2)

    snapshotCalls[1]?.resolve(createSnapshot(200))
    await flushImmediatePromises()
    expect(snapshotCalls).toHaveLength(3)
    snapshotCalls[2]?.resolve(createSnapshot(200))
    await second

    snapshotCalls[0]?.resolve(createSnapshot(100))
    await first

    expect(store.getState().codexUsageSummary?.totalTokens).toBe(200)
    expect(store.getState().codexUsageAccountFilter).toEqual({
      kind: 'managed',
      accountId: 'account-b'
    })
    expect(snapshotCalls).toHaveLength(3)
  })
})
