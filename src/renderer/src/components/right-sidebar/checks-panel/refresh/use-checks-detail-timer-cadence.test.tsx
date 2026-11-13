// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecksDetailPollingPolicy } from '../../../../../../shared/github/checks/checks-detail-polling-policy'
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

  function mount(
    executionHostId?: `runtime:${string}`,
    pr: Partial<NonNullable<ChecksPanelPollingInput['pr']>> = {}
  ) {
    const overrides: Partial<ChecksPanelPollingInput> = {}
    if (Object.keys(pr).length > 0) {
      overrides.pr = { ...createModel().pr!, ...pr }
    }
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

  async function focusWindow(): Promise<void> {
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
  }

  it('reads fresh checks when the window regains focus while off, without a visibility change', async () => {
    setPRAutoRefreshCadence('off')
    const { fetchChecks } = mount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchChecks).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    })
    await focusWindow()
    expect(fetchChecks).toHaveBeenCalledTimes(2)
    // A focus read is the user looking: the host must not pace it.
    expect(fetchChecks).toHaveBeenLastCalledWith({ force: false })
    // Focus starts no timer while off.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000)
    })
    expect(fetchChecks).toHaveBeenCalledTimes(2)
  })

  it('does not re-read on focus while off within the minute after the last read', async () => {
    setPRAutoRefreshCadence('off')
    const { fetchChecks } = mount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    await focusWindow()
    expect(fetchChecks).toHaveBeenCalledTimes(1)
  })

  it('does not re-read settled checks on focus while off', async () => {
    setPRAutoRefreshCadence('off')
    const { fetchChecks } = mount(undefined, { state: 'merged', checksStatus: 'success' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchChecks).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000)
    })
    await focusWindow()
    expect(fetchChecks).toHaveBeenCalledTimes(1)
  })

  it('reads at once when the window returns under reduced, then follows the stretched interval', async () => {
    setPRAutoRefreshCadence('reduced')
    const { fetchChecks } = mount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchChecks).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000)
    })
    expect(fetchChecks).toHaveBeenCalledTimes(1)
    await focusWindow()
    expect(fetchChecks).toHaveBeenCalledTimes(2)
    // The return is the user looking: the host must not pace it.
    expect(fetchChecks).toHaveBeenLastCalledWith({ force: false })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 2_000)
    })
    expect(fetchChecks).toHaveBeenCalledTimes(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(fetchChecks).toHaveBeenCalledTimes(3)
    expect(fetchChecks).toHaveBeenLastCalledWith({ force: false, background: true })
  })

  it('does not re-read on a return under reduced within the Default interval', async () => {
    setPRAutoRefreshCadence('reduced')
    const { fetchChecks } = mount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    await focusWindow()
    expect(fetchChecks).toHaveBeenCalledTimes(1)
  })
})
