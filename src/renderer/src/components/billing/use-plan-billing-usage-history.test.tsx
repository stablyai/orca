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
})
