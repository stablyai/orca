// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecksDetailPollingPolicy } from '../../../../../../shared/github/checks-detail-polling-policy'
import {
  _resetPRAutoRefreshCadencesForTests,
  setPRAutoRefreshCadence,
  setPRAutoRefreshCadenceForHost
} from '../../../../../../shared/review-refresh-policy'
import { createModel } from './checks-panel-polling-test-model'
import type { ChecksPanelPollingInput } from './use-checks-panel-polling'

vi.mock('@/store/github/refresh/remote-host-pr-auto-refresh-cadence', async () => {
  const policy = await import('../../../../../../shared/review-refresh-policy')
  return {
    hostPRAutoRefreshCadence: (environmentId: string | null) =>
      policy.getPRAutoRefreshCadenceForHost(environmentId)
  }
})
vi.mock('@/store/github/repositories/repository-routing', () => ({
  getPRRefreshOwnerRuntimeEnvironmentId: (candidate: { executionHostId?: string | null }) =>
    candidate.executionHostId?.startsWith('runtime:')
      ? candidate.executionHostId.slice('runtime:'.length)
      : null
}))

import { useChecksDetailTimer } from './use-checks-detail-timer'

describe('checks detail timer follows PR auto-refresh cadence changes while mounted', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    _resetPRAutoRefreshCadencesForTests()
  })

  function mount(executionHostId?: `runtime:${string}`) {
    const overrides: Partial<ChecksPanelPollingInput> = {}
    if (executionHostId) {
      overrides.repo = {
        id: 'repo-1',
        path: '/workspace/repo',
        displayName: 'Repo',
        badgeColor: '',
        addedAt: 1,
        executionHostId
      }
    }
    const model = createModel(overrides)
    const fetchChecks = vi.fn(async () => {})
    const fetchGitLabDetails = vi.fn(async () => {})
    const rendered = renderHook(() => {
      const modelRef = useRef(model)
      const policyRef = useRef(new ChecksDetailPollingPolicy())
      useChecksDetailTimer({
        model,
        modelRef,
        policyRef,
        requestIdentity: 'same-pr',
        fetchChecks,
        fetchGitLabDetails
      })
    })
    return { ...rendered, fetchChecks }
  }

  it('starts polling again when off becomes default, without another event', async () => {
    setPRAutoRefreshCadence('off')
    const { fetchChecks } = mount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchChecks).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    })
    expect(fetchChecks).toHaveBeenCalledTimes(1)

    await act(async () => {
      setPRAutoRefreshCadence('default')
      await vi.advanceTimersByTimeAsync(0)
    })
    // Five minutes since the last read: the pending backoff (60 s) is long overdue, so it reads now.
    expect(fetchChecks).toHaveBeenCalledTimes(2)
  })

  it('disarms an armed poll when default becomes off', async () => {
    const { fetchChecks } = mount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchChecks).toHaveBeenCalledTimes(1)
    await act(async () => {
      setPRAutoRefreshCadence('off')
      await vi.advanceTimersByTimeAsync(60 * 60_000)
    })
    expect(fetchChecks).toHaveBeenCalledTimes(1)
  })

  it('polls a paired host’s PR by that host’s cadence, not this app’s', async () => {
    setPRAutoRefreshCadence('off')
    setPRAutoRefreshCadenceForHost('env-1', 'default')
    const { fetchChecks } = mount('runtime:env-1')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchChecks).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000 + 1_000)
    })
    expect(fetchChecks).toHaveBeenCalledTimes(2)
    // A timer tick on a paired host is a background read the host may pace.
    expect(fetchChecks).toHaveBeenLastCalledWith({ force: false, background: true })
  })
})
