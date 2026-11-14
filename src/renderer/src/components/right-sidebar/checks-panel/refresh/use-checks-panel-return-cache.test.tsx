// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RuntimeRpcCallQueuePool } from '../../../../../../shared/runtime-rpc-call-queue'
import type { PRCheckDetail } from '../../../../../../shared/github/checks/check-types'
import {
  _resetPRAutoRefreshCadencesForTests,
  setPRAutoRefreshCadenceForHost
} from '../../../../../../shared/review-refresh-policy'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from '@/store/github/github-slice-test-harness'
import { createModel } from './checks-panel-polling-test-model'
import { useChecksPanelPolling } from './use-checks-panel-polling'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  setPRAutoRefreshCadenceForHost('env-1', 'reduced')
  resetRemoteRuntimeMocks()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  _resetPRAutoRefreshCadencesForTests()
  resetRemoteRuntimeMocks()
})

it.each(['background', 'fresh'] as const)(
  'shows fresh checks after returning during a %s read through the real callback and renderer cache',
  async (intent) => {
    const pendingChecks: PRCheckDetail[] = [
      { name: 'Build', status: 'in_progress', conclusion: null, url: null }
    ]
    const freshChecks: PRCheckDetail[] = [
      { name: 'Build', status: 'completed', conclusion: 'success', url: null }
    ]
    const pool = new RuntimeRpcCallQueuePool()
    const store = createTestStore()
    const model = createModel()
    model.repo = { ...model.repo!, executionHostId: 'runtime:env-1' }
    store.setState({ repos: [model.repo!], worktreesByRepo: {} })
    model.fetchPRChecks = store.getState().fetchPRChecks
    const reads: {
      issuedAt: number
      noCache: boolean
      background: boolean
      admittedAt?: number
      completedAt?: number
    }[] = []
    const pending: Promise<unknown>[] = []
    let hostObservedAt = -Infinity
    let reusedObservationAt = -Infinity
    const saturate = () => {
      // ast-grep-ignore: test-no-polling-loop-tsx -- Fixed fake-clock operations fill the real RPC admission pool.
      for (let call = 0; call < 24; call += 1) {
        pending.push(
          pool.enqueue(
            'env-1',
            'files.read',
            // ast-grep-ignore: test-no-real-time-wait -- Fake-clock provider time holds the real admission slot.
            () => new Promise((resolve) => setTimeout(resolve, 21_000))
          )
        )
      }
    }
    runtimeEnvironmentCall.mockImplementation(async ({ method, params }) => {
      if (method !== 'github.prChecks') {
        throw new Error(`Unexpected RPC method: ${method}`)
      }
      const read: (typeof reads)[number] = {
        issuedAt: Date.now(),
        noCache: params?.noCache === true,
        background: params?.reason === 'swr'
      }
      reads.push(read)
      const answer = pool.enqueue(
        'env-1',
        'github.prChecks',
        async () => {
          read.admittedAt = Date.now()
          // ast-grep-ignore: test-no-real-time-wait -- Fake-clock provider completion preserves the tested response ordering.
          await new Promise((resolve) => setTimeout(resolve, 2_000))
          read.completedAt = Date.now()
          if (
            (intent === 'background' && reads[0] === read) ||
            (read.background && !read.noCache)
          ) {
            if (reads[0] !== read) {
              reusedObservationAt = read.issuedAt - 50_000
            }
            return pendingChecks
          }
          hostObservedAt = Date.now()
          return freshChecks
        },
        0,
        undefined,
        params
      )
      pending.push(answer)
      return { id: 'rpc', ok: true, result: await answer }
    })
    if (intent === 'fresh') {
      saturate()
    }
    renderHook(() => useChecksPanelPolling(model))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    if (intent === 'background') {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(301_000)
      })
      saturate()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
    }
    const original = reads.at(-1)!
    const focusAt = original.issuedAt + 61_000
    await act(async () => {
      await vi.advanceTimersByTimeAsync(focusAt - Date.now())
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(original.issuedAt + 75_000 - Date.now())
    })
    await Promise.all(pending)
    expect(model.setChecks).toHaveBeenLastCalledWith(freshChecks)
    expect(Object.values(store.getState().checksCache).at(-1)?.data).toEqual(freshChecks)
    expect(hostObservedAt).toBeGreaterThanOrEqual(focusAt)
    expect(original.admittedAt).toBeGreaterThanOrEqual(focusAt)
    expect(original.completedAt).toBeGreaterThan(focusAt)
    if (intent === 'background') {
      expect(reusedObservationAt).toBe(original.issuedAt - 50_000)
    }
    expect(
      reads
        .slice(reads.indexOf(original) + 1)
        .map(({ noCache, background }) => ({ noCache, background }))
    ).toEqual(intent === 'background' ? [{ noCache: true, background: false }] : [])
  }
)
