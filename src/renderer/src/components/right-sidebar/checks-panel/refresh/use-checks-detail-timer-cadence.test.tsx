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
import { RuntimeRpcCallQueuePool } from '../../../../../../shared/runtime-rpc-call-queue'

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
    pr: Partial<NonNullable<ChecksPanelPollingInput['pr']>> = {},
    fetchImpl: (options?: { background?: boolean }) => Promise<void> = async () => {},
    gitlab = false
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
    if (gitlab) {
      model.activeGitLabReview = {
        provider: 'gitlab',
        number: 42,
        title: 'Review',
        state: 'open',
        url: '',
        status: 'pending',
        updatedAt: '',
        mergeable: 'UNKNOWN'
      }
    }
    const fetchChecks = vi.fn(fetchImpl)
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
    return { ...rendered, fetchChecks, fetchGitLabDetails, model }
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
    expect(fetchChecks).toHaveBeenLastCalledWith({ force: true })
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
    expect(fetchChecks).toHaveBeenLastCalledWith({ force: true })

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

  it('keeps the stopped-distro guard on a GitLab focus return', async () => {
    setPRAutoRefreshCadence('reduced')
    const { fetchGitLabDetails } = mount(undefined, {}, undefined, true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    await focusWindow()
    expect(fetchGitLabDetails).toHaveBeenLastCalledWith({ background: true })
  })

  // Three finite waves of eight ordinary calls (21 s each after their
  // own admission) hold the checks read about 63 s before it is sent.
  it.each(['background', 'fresh', 'reopen', 'fresh-reopen'] as const)(
    'satisfies a return while a %s checks read waits for admission',
    async (arm) => {
      setPRAutoRefreshCadenceForHost('env-1', 'reduced')
      const pool = new RuntimeRpcCallQueuePool()
      type Observation = { observedAt: number; by: string }
      type Operation = {
        id: number
        background: boolean
        issuedAt: number
        admittedAt?: number
        completedAt?: number
        returned?: Observation
      }
      const operations: Operation[] = []
      const blockers: { queuedAt: number; admittedAt?: number; doneAt?: number }[] = []
      const pending: Promise<unknown>[] = []
      let hostRead: Observation | null = null
      let visible: Observation | null = null
      const saturate = () => {
        for (let call = 0; call < 24; call += 1) {
          const blocker: (typeof blockers)[number] = { queuedAt: Date.now() }
          blockers.push(blocker)
          pending.push(
            pool.enqueue('env-1', 'files.read', async () => {
              blocker.admittedAt = Date.now()
              await new Promise((resolve) => setTimeout(resolve, 21_000))
              blocker.doneAt = Date.now()
            })
          )
        }
      }
      const fetchImpl = async (options: { background?: boolean } = {}) => {
        const operation: Operation = {
          id: operations.length,
          background: options.background === true,
          issuedAt: Date.now()
        }
        operations.push(operation)
        const answered = pool.enqueue(
          'env-1',
          'github.prChecks',
          async () => {
            operation.admittedAt = Date.now()
            await new Promise((resolve) => setTimeout(resolve, 2_000))
            const paced =
              operation.background &&
              hostRead !== null &&
              Date.now() - hostRead.observedAt < 300_000
            if (!paced) {
              hostRead = { observedAt: Date.now(), by: `operation ${operation.id}` }
            }
            operation.completedAt = Date.now()
            operation.returned = hostRead!
            return hostRead!
          },
          0,
          undefined,
          operation.background ? { reason: 'swr' } : {}
        )
        pending.push(answered)
        visible = await answered
      }
      let original: Operation
      let panel: ReturnType<typeof mount> | undefined
      if (arm === 'fresh' || arm === 'fresh-reopen') {
        // The lane is full before the panel opens: the opening (fresh) read itself waits.
        saturate()
        panel = mount('runtime:env-1', {}, fetchImpl)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0)
        })
        original = operations[0]!
        hostRead = { observedAt: original.issuedAt - 50_000, by: 'another reader' }
      } else {
        panel = mount('runtime:env-1', {}, fetchImpl)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_100)
        })
        // Reduced, open and pending: the next timer read is about 300 s after the first completed.
        // The lane fills one second before it; then the tick is awaited.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(operations[0]!.completedAt! + 299_000 - Date.now())
        })
        expect(operations.length, 'no timer read before the lane fills').toBe(1)
        saturate()
        for (let step = 0; step < 50 && operations.length === 1; step += 1) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(100)
          })
        }
        original = operations[1]!
        // Another reader of the same head filled the host's paced read 50 s before this one.
        hostRead = { observedAt: original.issuedAt - 50_000, by: 'another reader' }
      }
      const A = original.issuedAt
      // The window comes back 61 s after the original read was issued: past Default's 60 s age.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(A + 61_000 - Date.now())
      })
      const focusAt = Date.now()
      if (arm === 'reopen' || arm === 'fresh-reopen') {
        await act(async () => {
          panel!.model.isPanelVisible = false
          panel!.rerender()
        })
        await act(async () => {
          panel!.model.isPanelVisible = true
          panel!.rerender()
        })
      }
      if (arm === 'background' || arm === 'fresh') {
        await act(async () => {
          window.dispatchEvent(new Event('focus'))
          await vi.advanceTimersByTimeAsync(0)
        })
      }
      const afterFocus = operations.length
      // Admission about 63 s after issue, answer 2 s later; then 10 s more, well before the next tick.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(A + 75_000 - Date.now())
      })
      await Promise.all(pending)
      const evidence = JSON.stringify({ arm, A, focusAt, operations, blockers, visible }, null, 1)
      expect(original.background, `original intent\n${evidence}`).toBe(
        arm === 'background' || arm === 'reopen'
      )
      expect(focusAt - A, `focus at A + 61 s\n${evidence}`).toBe(61_000)
      expect(afterFocus, `the return found the original in flight\n${evidence}`).toBe(
        operations.indexOf(original) + 1
      )
      expect(
        original.admittedAt! - A >= 61_000,
        `held before send past the return\n${evidence}`
      ).toBe(true)
      expect(
        original.completedAt! > focusAt,
        `original completed after the return\n${evidence}`
      ).toBe(true)
      const later = operations.slice(operations.indexOf(original) + 1)
      if (arm === 'background' || arm === 'reopen') {
        expect(
          original.returned,
          `original returned the paced read observed at A - 50 s\n${evidence}`
        ).toEqual({ observedAt: A - 50_000, by: 'another reader' })
        // The qualifying return stays owed after that stale completion, as
        // exactly one fresh read, and its fresh observation is what the checks show.
        expect(
          later.map((operation) => operation.background),
          `exactly one owed fresh read\n${evidence}`
        ).toEqual([false])
        expect(
          visible!.observedAt >= focusAt && visible!.by === `operation ${later[0]?.id}`,
          `the fresh read's observation is shown\n${evidence}`
        ).toBe(true)
      } else {
        // Control: the original fresh completion satisfies the return; no duplicate trailing read.
        expect(original.returned!.observedAt >= focusAt, `fresh answer\n${evidence}`).toBe(true)
        expect(visible, `fresh answer shown\n${evidence}`).toEqual(original.returned)
        expect(later, `no duplicate read\n${evidence}`).toEqual([])
      }
    }
  )
})
