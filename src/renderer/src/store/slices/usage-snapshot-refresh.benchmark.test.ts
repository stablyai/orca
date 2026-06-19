import { performance } from 'node:perf_hooks'
import { create } from 'zustand'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type {
  CodexUsageScanState,
  CodexUsageSnapshot,
  CodexUsageSummary
} from '../../../../shared/codex-usage-types'
import { createCodexUsageSlice } from './codex-usage'

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

function createCodexOnlyStore() {
  return create<AppState>()((...args) => createCodexUsageSlice(...args) as AppState)
}

function createScanState(overrides: Partial<CodexUsageScanState> = {}): CodexUsageScanState {
  return {
    enabled: true,
    isScanning: false,
    lastScanStartedAt: 100,
    lastScanCompletedAt: 200,
    lastScanError: null,
    hasAnyCodexData: true,
    ...overrides
  }
}

function createSummary(totalTokens: number): CodexUsageSummary {
  return {
    scope: 'orca',
    range: '30d',
    sessions: totalTokens / 100,
    events: totalTokens / 10,
    inputTokens: totalTokens / 2,
    cachedInputTokens: totalTokens / 10,
    outputTokens: totalTokens / 2,
    reasoningOutputTokens: 0,
    totalTokens,
    estimatedCostUsd: 1,
    topModel: 'gpt-5',
    topProject: 'orca',
    hasAnyCodexData: true
  }
}

function createSnapshot(totalTokens: number, scanState = createScanState()): CodexUsageSnapshot {
  return {
    scanState,
    summary: createSummary(totalTokens),
    daily: [
      {
        day: '2026-04-10',
        inputTokens: totalTokens / 2,
        cachedInputTokens: totalTokens / 10,
        outputTokens: totalTokens / 2,
        reasoningOutputTokens: 0,
        totalTokens
      }
    ],
    modelBreakdown: [],
    projectBreakdown: [],
    recentSessions: []
  }
}

describe('Codex usage cached snapshot benchmark', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders cached usage before a slow refresh completes', async () => {
    const slowRefresh = createDeferred<CodexUsageScanState>()
    const getSnapshot = vi
      .fn()
      .mockResolvedValueOnce(createSnapshot(100))
      .mockResolvedValueOnce(createSnapshot(200, createScanState({ lastScanCompletedAt: 300 })))
    const refresh = vi.fn(() => slowRefresh.promise)

    vi.stubGlobal('window', {
      api: {
        codexUsage: {
          getScanState: vi.fn(() => Promise.resolve(createScanState())),
          getSnapshot,
          refresh,
          setEnabled: vi.fn(),
          getSummary: vi.fn(),
          getDaily: vi.fn(),
          getBreakdown: vi.fn(),
          getRecentSessions: vi.fn()
        }
      }
    })

    const store = createCodexOnlyStore()
    const startedAt = performance.now()
    const fetchPromise = store.getState().fetchCodexUsage()

    await flushImmediatePromises()
    expect(store.getState().codexUsageSummary?.totalTokens).toBe(100)
    const cachedRenderMs = performance.now() - startedAt

    expect(cachedRenderMs).toBeLessThan(10)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(getSnapshot).toHaveBeenCalledTimes(1)

    slowRefresh.resolve(createScanState({ lastScanCompletedAt: 300 }))
    await fetchPromise

    expect(store.getState().codexUsageSummary?.totalTokens).toBe(200)
    expect(getSnapshot).toHaveBeenCalledTimes(2)
    expect(window.api.codexUsage.getSummary).not.toHaveBeenCalled()
    expect(window.api.codexUsage.getDaily).not.toHaveBeenCalled()
    expect(window.api.codexUsage.getBreakdown).not.toHaveBeenCalled()
    expect(window.api.codexUsage.getRecentSessions).not.toHaveBeenCalled()
  })
})
