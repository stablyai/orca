// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { USAGE_HISTORY_TIMEOUT_MS, usePlanBillingUsageHistory } from './use-plan-billing-usage-history'

vi.mock('./team/use-org-roster', () => ({ useOrgRoster: () => ({ result: null }) }))

describe('usePlanBillingUsageHistory', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // A read that never answers.
    Object.assign(window, {
      api: {
        orcaProfiles: { billingUsageHistory: () => new Promise(() => {}) },
        cloudWorkspaces: { list: () => new Promise(() => {}) }
      }
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops loading and reports failed when the read never answers', async () => {
    const { result } = renderHook(() => usePlanBillingUsageHistory('acct|1', null, null, false))
    expect(result.current.state.status).toBe('loading')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(USAGE_HISTORY_TIMEOUT_MS + 10)
    })
    expect(result.current.state.status).toBe('failed')
  })

  it('fails after 15 s from mount when the account key never arrives, and Try again waits again', async () => {
    const { result } = renderHook(() => usePlanBillingUsageHistory(null, null, null, false))
    expect(result.current.state.status).toBe('loading')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(USAGE_HISTORY_TIMEOUT_MS - 100)
    })
    expect(result.current.state.status).toBe('loading')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(result.current.state.status).toBe('failed')
    act(() => result.current.retry())
    expect(result.current.state.status).toBe('loading')
  })

  it('shows the chart when the key arrives late and the read answers', async () => {
    const history = {
      days: [{ start: 0, seconds: 3600 }],
      totalSeconds: 3600,
      yourSeconds: 3600,
      members: null,
      sandboxes: null
    }
    Object.assign(window.api.orcaProfiles, {
      billingUsageHistory: () => Promise.resolve({ status: 'ok' as const, history })
    })
    const initialProps: { key: string | null } = { key: null }
    const { result, rerender } = renderHook(
      ({ key }: { key: string | null }) => usePlanBillingUsageHistory(key, null, null, false),
      { initialProps }
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    rerender({ key: 'acct|1' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.state.status).toBe('ok')
  })
})
