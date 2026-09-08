// @vitest-environment happy-dom

import { createElement, StrictMode, type ReactNode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AI_VAULT_SEARCH_COVERAGE_RETRY_MAX_MS,
  createSearchCoverageStore
} from './ai-vault-search-coverage-store'
import type {
  AiVaultSearchCoverage,
  AiVaultSearchIndexingProgress
} from '../../../../shared/ai-vault-search-types'
import {
  AI_VAULT_SEARCH_COVERAGE_POLL_MS,
  useAiVaultSearchCoveragePoll
} from './ai-vault-search-coverage-poll'

function coverage(
  backfill: AiVaultSearchCoverage['backfill'],
  indexing?: Partial<AiVaultSearchIndexingProgress>
): AiVaultSearchCoverage {
  return {
    enabled: true,
    sessionsIndexed: 5,
    messagesIndexed: 20,
    providers: [],
    backfill,
    filesPending: 0,
    lastIndexedAt: null,
    ...(indexing
      ? {
          indexing: {
            phase: 'indexing',
            filesProcessed: 1,
            filesTotal: 10,
            failures: 0,
            startedAt: 0,
            ...indexing
          }
        }
      : {})
  }
}

let searchCoverage: ReturnType<typeof vi.fn>
let focusListeners: (() => void)[]
let changedListeners: (() => void)[]

/** The desktop transport: the host pushes every coverage-affecting change it makes. */
function installApi({ changePush = true }: { changePush?: boolean } = {}): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      aiVault: {
        searchCoverage,
        onWindowFocused: (callback: () => void) => {
          focusListeners.push(callback)
          return () => {
            focusListeners = focusListeners.filter((listener) => listener !== callback)
          }
        },
        ...(changePush
          ? {
              onSearchIndexingChanged: (callback: () => void) => {
                changedListeners.push(callback)
                return () => {
                  changedListeners = changedListeners.filter((listener) => listener !== callback)
                }
              }
            }
          : {})
      }
    }
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  focusListeners = []
  changedListeners = []
  searchCoverage = vi.fn().mockResolvedValue(coverage('running', { phase: 'indexing' }))
  installApi()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
  createElement(StrictMode, null, children)

describe('useAiVaultSearchCoveragePoll', () => {
  it('asks for nothing while transcript search is off', () => {
    const { result } = renderHook(() => useAiVaultSearchCoveragePoll(false, null, 'off'), {
      wrapper
    })
    expect(searchCoverage).not.toHaveBeenCalled()
    expect(result.current).toBeNull()
  })

  it('keeps polling while the backfill is still running', async () => {
    renderHook(() => useAiVaultSearchCoveragePoll(true, null, 'running-owner'), { wrapper })
    await act(async () => {})

    const callsAfterFirstRead = searchCoverage.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
    })
    expect(searchCoverage.mock.calls.length).toBeGreaterThan(callsAfterFirstRead)
  })

  it('stops polling once the index reports it is up to date', async () => {
    searchCoverage.mockResolvedValue(coverage('complete', { phase: 'complete' }))
    const { result } = renderHook(
      () => useAiVaultSearchCoveragePoll(true, null, 'complete-owner'),
      {
        wrapper
      }
    )
    await act(async () => {})

    expect(result.current?.sessionsIndexed).toBe(5)
    const callsAfterFirstRead = searchCoverage.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS * 5)
    })
    expect(searchCoverage).toHaveBeenCalledTimes(callsAfterFirstRead)
  })

  it('stops polling a host that reports no indexing progress at all', async () => {
    searchCoverage.mockResolvedValue(coverage('complete'))
    renderHook(() => useAiVaultSearchCoveragePoll(true, null, 'legacy-owner'), { wrapper })
    await act(async () => {})

    const callsAfterFirstRead = searchCoverage.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS * 5)
    })
    expect(searchCoverage).toHaveBeenCalledTimes(callsAfterFirstRead)
  })

  it('re-reads a settled index when the window is focused again', async () => {
    searchCoverage.mockResolvedValue(coverage('complete', { phase: 'complete' }))
    renderHook(() => useAiVaultSearchCoveragePoll(true, null, 'focus-owner'), { wrapper })
    await act(async () => {})
    const callsAfterFirstRead = searchCoverage.mock.calls.length

    await act(async () => {
      focusListeners.forEach((listener) => listener())
    })
    expect(searchCoverage).toHaveBeenCalledTimes(callsAfterFirstRead + 1)
  })

  it('resumes polling when a focus read finds the index working again', async () => {
    searchCoverage.mockResolvedValue(coverage('complete', { phase: 'complete' }))
    renderHook(() => useAiVaultSearchCoveragePoll(true, null, 'refocus-owner'), { wrapper })
    await act(async () => {})

    searchCoverage.mockResolvedValue(coverage('running', { phase: 'indexing' }))
    await act(async () => {
      focusListeners.forEach((listener) => listener())
    })
    const callsAfterFocus = searchCoverage.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
    })
    expect(searchCoverage.mock.calls.length).toBeGreaterThan(callsAfterFocus)
  })

  it('publishes consistently slow successes without overlapping polls', async () => {
    searchCoverage.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(coverage('running', { phase: 'indexing' })), 5_000)
        )
    )
    const { result } = renderHook(() => useAiVaultSearchCoveragePoll(true, null, 'slow-owner'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
    expect(result.current?.backfill).toBe('running')
    expect(searchCoverage).toHaveBeenCalledTimes(3)
  })

  it('drops the last reading when search is turned off', async () => {
    const { rerender, result } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useAiVaultSearchCoveragePoll(enabled, null, 'toggle-owner'),
      { initialProps: { enabled: true }, wrapper }
    )
    await act(async () => {})
    expect(result.current).not.toBeNull()

    rerender({ enabled: false })
    expect(result.current).toBeNull()
  })

  it('publishes the coverage a search already returned instead of re-reading it', async () => {
    const fromSearch = coverage('running', { phase: 'indexing', filesProcessed: 7 })
    const { rerender, result } = renderHook(
      ({ latest }: { latest: AiVaultSearchCoverage | null }) =>
        useAiVaultSearchCoveragePoll(true, latest, 'observe-owner'),
      { wrapper, initialProps: { latest: null as AiVaultSearchCoverage | null } }
    )
    await act(async () => {})
    const callsAfterMount = searchCoverage.mock.calls.length

    await act(async () => {
      rerender({ latest: fromSearch })
    })
    // A result arriving must publish what it carried, not spend a round trip re-asking for it.
    expect(searchCoverage).toHaveBeenCalledTimes(callsAfterMount)
    expect(result.current?.indexing?.filesProcessed).toBe(7)
  })
})

it('drops coverage from the previous runtime immediately and polls the new owner', async () => {
  const { result, rerender } = renderHook(
    ({ host }) => useAiVaultSearchCoveragePoll(true, null, host),
    { initialProps: { host: 'runtime:a' }, wrapper }
  )
  await act(async () => {})
  expect(result.current?.sessionsIndexed).toBe(5)
  let release!: (value: AiVaultSearchCoverage) => void
  searchCoverage.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  rerender({ host: 'runtime:b' })
  expect(result.current).toBeNull()
  await act(async () => {
    release({ ...coverage('complete'), sessionsIndexed: 9 })
  })
  expect(result.current?.sessionsIndexed).toBe(9)
})

it('shares a single polling subscription between surfaces', async () => {
  const first = renderHook(() => useAiVaultSearchCoveragePoll(true, null, 'shared-owner'))
  const second = renderHook(() => useAiVaultSearchCoveragePoll(true, null, 'shared-owner'))
  await act(async () => {})
  expect(searchCoverage).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
  })
  expect(searchCoverage).toHaveBeenCalledTimes(2)
  first.unmount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
  })
  expect(searchCoverage).toHaveBeenCalledTimes(3)
  second.unmount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
  })
  expect(searchCoverage).toHaveBeenCalledTimes(3)
})

it('observes controls after mutation and ignores the outstanding older poll', async () => {
  let releaseOld!: (value: AiVaultSearchCoverage) => void
  let finishAction!: () => void
  searchCoverage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseOld = resolve
      })
  )
  const store = createSearchCoverageStore()
  const unsubscribe = store.subscribe(() => undefined)
  const controlled = store.control(
    () =>
      new Promise<void>((resolve) => {
        finishAction = resolve
      })
  )
  await vi.advanceTimersByTimeAsync(8_000)
  expect(searchCoverage).toHaveBeenCalledTimes(1)
  finishAction()
  await controlled
  expect(store.getSnapshot().coverage?.backfill).toBe('running')
  releaseOld(coverage('complete'))
  await Promise.resolve()
  expect(store.getSnapshot().coverage?.backfill).toBe('running')
  unsubscribe()
})

it('still reports busy when the last surface unsubscribes mid-control', async () => {
  const store = createSearchCoverageStore()
  const unsubscribe = store.subscribe(() => undefined)
  let finishAction!: () => void
  const controlled = store.control(
    () =>
      new Promise<void>((resolve) => {
        finishAction = resolve
      })
  )
  unsubscribe()

  // Why: a snapshot that forgot the running action would let a second surface start a rival one.
  expect(store.getSnapshot().busy).toBe(true)
  const rival = vi.fn().mockResolvedValue(undefined)
  await store.control(rival)
  expect(rival).not.toHaveBeenCalled()

  finishAction()
  await controlled
  expect(store.getSnapshot().busy).toBe(false)
})

it('keeps the last good reading when the only surface unmounts', async () => {
  const store = createSearchCoverageStore()
  const unsubscribe = store.subscribe(() => undefined)
  await vi.advanceTimersByTimeAsync(0)
  expect(store.getSnapshot().coverage).not.toBeNull()
  unsubscribe()
  // Why: resetting here made the settings panel flash "Reading index status…" on a remount.
  expect(store.getSnapshot().coverage).not.toBeNull()
})

it('ages one indexing run from the renderer clock, not the host clock', async () => {
  const store = createSearchCoverageStore()
  searchCoverage.mockResolvedValue(coverage('running', { phase: 'updating', startedAt: 10 ** 12 }))
  const unsubscribe = store.subscribe(() => undefined)
  await vi.advanceTimersByTimeAsync(0)
  const first = store.getSnapshot()
  expect(first.observedAt - first.phaseSince).toBe(0)

  await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS * 2)
  const later = store.getSnapshot()
  expect(later.phaseSince).toBe(first.phaseSince)
  expect(later.observedAt - later.phaseSince).toBeGreaterThanOrEqual(
    AI_VAULT_SEARCH_COVERAGE_POLL_MS
  )
  unsubscribe()
})

it('re-reads after a control whose backfill had not started when the read landed', async () => {
  searchCoverage.mockResolvedValue(coverage('complete', { phase: 'complete' }))
  const store = createSearchCoverageStore()
  const unsubscribe = store.subscribe(() => undefined)
  await vi.advanceTimersByTimeAsync(0)
  await store.control(() => Promise.resolve())
  // The apply has not flipped the phase yet, so the post-control read still reads as settled.
  expect(store.getSnapshot().coverage?.indexing?.phase).toBe('complete')

  searchCoverage.mockResolvedValue(coverage('running', { phase: 'indexing' }))
  changedListeners.forEach((listener) => listener())
  await vi.advanceTimersByTimeAsync(0)
  expect(store.getSnapshot().coverage?.indexing?.phase).toBe('indexing')
  unsubscribe()
})

it('re-reads when the change lands while the post-control read is still in flight', async () => {
  let releasePostControl!: (value: AiVaultSearchCoverage) => void
  searchCoverage
    .mockResolvedValueOnce(coverage('complete', { phase: 'complete' }))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePostControl = resolve
        })
    )
    .mockResolvedValue(coverage('running', { phase: 'indexing' }))
  const store = createSearchCoverageStore()
  const unsubscribe = store.subscribe(() => undefined)
  await vi.advanceTimersByTimeAsync(0)

  const controlled = store.control(() => Promise.resolve())
  await vi.advanceTimersByTimeAsync(0)
  expect(searchCoverage).toHaveBeenCalledTimes(2)
  // The apply lands while the post-control read is outstanding, so that read predates it.
  changedListeners.forEach((listener) => listener())
  releasePostControl(coverage('complete', { phase: 'complete' }))
  await controlled
  await vi.advanceTimersByTimeAsync(0)

  expect(searchCoverage).toHaveBeenCalledTimes(3)
  expect(store.getSnapshot().coverage?.indexing?.phase).toBe('indexing')
  unsubscribe()
})

it('keeps reading after a failed read instead of latching the failure', async () => {
  searchCoverage.mockRejectedValueOnce(new Error('index unreachable'))
  const store = createSearchCoverageStore()
  const unsubscribe = store.subscribe(() => undefined)
  await vi.advanceTimersByTimeAsync(0)
  expect(store.getSnapshot().failed).toBe(true)
  expect(searchCoverage).toHaveBeenCalledTimes(1)

  searchCoverage.mockResolvedValue(coverage('complete', { phase: 'complete' }))
  await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
  expect(searchCoverage).toHaveBeenCalledTimes(2)
  expect(store.getSnapshot().failed).toBe(false)
  unsubscribe()
})

it('ignores a search answer from an indexing run older than the one it holds', async () => {
  searchCoverage.mockResolvedValue(coverage('running', { phase: 'updating', startedAt: 5 }))
  const store = createSearchCoverageStore()
  const unsubscribe = store.subscribe(() => undefined)
  await vi.advanceTimersByTimeAsync(0)

  store.observe(coverage('complete', { phase: 'complete', startedAt: 1 }))
  expect(store.getSnapshot().coverage?.indexing?.phase).toBe('updating')
  const callsBefore = searchCoverage.mock.calls.length
  await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
  expect(searchCoverage.mock.calls.length).toBeGreaterThan(callsBefore)
  unsubscribe()
})

it('leaves an index nobody has searched alone until the host says otherwise', async () => {
  searchCoverage.mockResolvedValue(coverage('running', { phase: 'idle' }))
  const store = createSearchCoverageStore()
  const unsubscribe = store.subscribe(() => undefined)
  await vi.advanceTimersByTimeAsync(0)
  const callsAfterFirstRead = searchCoverage.mock.calls.length

  await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS * 5)
  expect(searchCoverage).toHaveBeenCalledTimes(callsAfterFirstRead)
  unsubscribe()
})

it('keeps a standing poll on a transport with no coverage-change push', async () => {
  changedListeners = []
  searchCoverage.mockResolvedValue(coverage('complete', { phase: 'complete' }))
  installApi({ changePush: false })
  const store = createSearchCoverageStore()
  const unsubscribe = store.subscribe(() => undefined)
  await vi.advanceTimersByTimeAsync(0)
  const callsAfterFirstRead = searchCoverage.mock.calls.length

  await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS * 2)
  expect(searchCoverage.mock.calls.length).toBeGreaterThan(callsAfterFirstRead)
  unsubscribe()
})

it('reports a refused control apart from a coverage read that did not land', async () => {
  const store = createSearchCoverageStore()
  const unsubscribe = store.subscribe(() => undefined)
  await vi.advanceTimersByTimeAsync(0)

  searchCoverage.mockRejectedValue(new Error('index unreachable'))
  await store.control(() => Promise.resolve())
  expect(store.getSnapshot().failed).toBe(true)
  expect(store.getSnapshot().controlFailed).toBe(false)

  searchCoverage.mockResolvedValue(coverage('running', { phase: 'indexing' }))
  await store.control(() => Promise.reject(new Error('save refused')))
  expect(store.getSnapshot().controlFailed).toBe(true)
  unsubscribe()
})

it('doubles the gap between reads a host keeps refusing, up to a ceiling', async () => {
  searchCoverage.mockRejectedValue(new Error('index unreachable'))
  const store = createSearchCoverageStore()
  const unsubscribe = store.subscribe(() => undefined)
  await vi.advanceTimersByTimeAsync(0)

  // 4s, then 8s, then 16s, then 32s, and never longer than 32s.
  const gaps = [4_000, 8_000, 16_000, AI_VAULT_SEARCH_COVERAGE_RETRY_MAX_MS, 32_000]
  let expected = 1
  expect(searchCoverage).toHaveBeenCalledTimes(expected)
  for (const gap of gaps) {
    await vi.advanceTimersByTimeAsync(gap - AI_VAULT_SEARCH_COVERAGE_POLL_MS)
    expect(searchCoverage).toHaveBeenCalledTimes(expected)
    await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
    expected += 1
    expect(searchCoverage).toHaveBeenCalledTimes(expected)
  }
  unsubscribe()
})

it('returns to the base retry gap once a read has landed', async () => {
  searchCoverage
    .mockRejectedValueOnce(new Error('index unreachable'))
    .mockResolvedValueOnce(coverage('running', { phase: 'indexing' }))
    .mockRejectedValue(new Error('index unreachable'))
  const store = createSearchCoverageStore()
  const unsubscribe = store.subscribe(() => undefined)
  await vi.advanceTimersByTimeAsync(0)

  await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
  expect(searchCoverage).toHaveBeenCalledTimes(2)
  // The success cleared the backoff, so the failure after it waits one base interval, not eight.
  await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
  expect(searchCoverage).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
  expect(searchCoverage).toHaveBeenCalledTimes(4)
  unsubscribe()
})

it('reads at once and clears the backoff when the host reports a change', async () => {
  searchCoverage.mockRejectedValue(new Error('index unreachable'))
  const store = createSearchCoverageStore()
  const unsubscribe = store.subscribe(() => undefined)
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
  expect(searchCoverage).toHaveBeenCalledTimes(2)

  changedListeners.forEach((listener) => listener())
  await vi.advanceTimersByTimeAsync(0)
  // An explicit host signal outranks a backoff built from failures that predate it.
  expect(searchCoverage).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
  expect(searchCoverage).toHaveBeenCalledTimes(4)
  unsubscribe()
})
