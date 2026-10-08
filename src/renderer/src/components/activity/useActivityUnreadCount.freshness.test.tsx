// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'

// Real slice, not a hand-rolled store: the hook subscribes to agentStatusEpoch alone, so the
// test must prove the reducer bumps that epoch for every transition the count depends on.
vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

import { useAppStore } from '@/store'
import { flushMicrotasks } from '@/store/slices/agent-status-test-harness'
import { useActivityUnreadCount } from './useActivityUnreadCount'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const START = 2_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})
afterEach(() => {
  useAppStore.getState().removeAgentStatus(PANE_KEY)
  vi.useRealTimers()
})

function setWorking(updatedAt: number): void {
  useAppStore
    .getState()
    .setAgentStatus(
      PANE_KEY,
      { state: 'working', prompt: 'Fix tests', agentType: 'claude' },
      undefined,
      { updatedAt, evidenceObservedAt: updatedAt }
    )
}

describe('useActivityUnreadCount freshness invalidation', () => {
  it('ignores same-turn heartbeats, decays at the stale boundary, revives on the next heartbeat', async () => {
    setWorking(START)
    const hook = renderHook(() => useActivityUnreadCount())
    expect(hook.result.current).toBe(1)
    const epochAfterStart = useAppStore.getState().agentStatusEpoch

    // Fresh same-turn heartbeat: no epoch bump, count unchanged.
    act(() => {
      vi.setSystemTime(START + 1_000)
      setWorking(START + 1_000)
    })
    expect(useAppStore.getState().agentStatusEpoch).toBe(epochAfterStart)
    expect(hook.result.current).toBe(1)

    // Freshness scheduler bumps the epoch at the stale boundary; the count decays with no write.
    await act(async () => {
      await flushMicrotasks()
      vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1)
    })
    expect(hook.result.current).toBe(0)

    // A heartbeat on a stale entry is sort-relevant, so the reducer bumps the epoch and revives it.
    const revivedAt = Date.now()
    act(() => {
      setWorking(revivedAt)
    })
    expect(hook.result.current).toBe(1)

    // Reading it holds across further heartbeats.
    act(() => {
      useAppStore.getState().acknowledgeAgents([PANE_KEY])
    })
    expect(hook.result.current).toBe(0)
    act(() => {
      vi.setSystemTime(revivedAt + 1_000)
      setWorking(revivedAt + 1_000)
    })
    expect(hook.result.current).toBe(0)
    hook.unmount()
  })
})
