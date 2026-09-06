// @vitest-environment happy-dom

import { createElement, StrictMode, type ReactNode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSearchCoverage } from '../../../../shared/ai-vault-search-types'
import {
  AI_VAULT_SEARCH_COVERAGE_POLL_MS,
  useAiVaultSearchCoveragePoll
} from './ai-vault-search-coverage-poll'

function coverage(backfill: AiVaultSearchCoverage['backfill']): AiVaultSearchCoverage {
  return {
    enabled: true,
    sessionsIndexed: 5,
    messagesIndexed: 20,
    providers: [],
    backfill,
    filesPending: 0,
    lastIndexedAt: null
  }
}

let searchCoverage: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  searchCoverage = vi.fn().mockResolvedValue(coverage('complete'))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { searchCoverage } }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
  createElement(StrictMode, null, children)

describe('useAiVaultSearchCoveragePoll', () => {
  it('asks for nothing while transcript search is off', () => {
    const { result } = renderHook(() => useAiVaultSearchCoveragePoll(false), { wrapper })
    expect(searchCoverage).not.toHaveBeenCalled()
    expect(result.current).toBeNull()
  })

  it('keeps observing a completed index so a later clear can report rebuilding', async () => {
    const { result } = renderHook(() => useAiVaultSearchCoveragePoll(true), { wrapper })
    await act(async () => {})

    expect(result.current?.sessionsIndexed).toBe(5)
    const callsAfterFirstRead = searchCoverage.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS * 3)
    })
    expect(searchCoverage).toHaveBeenCalledTimes(callsAfterFirstRead + 3)
  })

  it('ignores a slow running answer that lands after a newer complete one', async () => {
    let releaseFirst: (value: ReturnType<typeof coverage>) => void = () => undefined
    searchCoverage
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve
          })
      )
      .mockResolvedValueOnce(coverage('complete'))
    const { result } = renderHook(() => useAiVaultSearchCoveragePoll(true), { wrapper })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
    })
    expect(result.current?.backfill).toBe('complete')
    await act(async () => {
      releaseFirst(coverage('running'))
    })
    expect(result.current?.backfill).toBe('complete')
  })

  it('keeps polling while the backfill is still running', async () => {
    searchCoverage.mockResolvedValue(coverage('running'))
    renderHook(() => useAiVaultSearchCoveragePoll(true), { wrapper })
    await act(async () => {})

    const callsAfterFirstRead = searchCoverage.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
    })
    expect(searchCoverage.mock.calls.length).toBeGreaterThan(callsAfterFirstRead)
  })

  it('drops the last reading when search is turned off', async () => {
    const { rerender, result } = renderHook(
      ({ enabled }: { enabled: boolean }) => useAiVaultSearchCoveragePoll(enabled),
      { initialProps: { enabled: true }, wrapper }
    )
    await act(async () => {})
    expect(result.current).not.toBeNull()

    rerender({ enabled: false })
    expect(result.current).toBeNull()
  })
})
