// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'

vi.mock('@/store', () => ({
  useAppStore: create(() => ({
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    acknowledgedAgentsByPaneKey: {},
    activityClearedAtByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    retainedAgentsByPaneKey: {}
  }))
}))

import { useAppStore } from '@/store'
import { useActivityUnreadCount } from './useActivityUnreadCount'

const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'

afterEach(() => vi.useRealTimers())

describe('useActivityUnreadCount freshness invalidation', () => {
  it('decays on the status epoch and revives on a heartbeat without an epoch change', () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000)
    const entry: AgentStatusEntry = {
      paneKey,
      state: 'working',
      prompt: '',
      updatedAt: 2_000,
      stateStartedAt: 2_000,
      stateHistory: [],
      agentType: 'claude'
    }
    useAppStore.setState({ agentStatusByPaneKey: { [paneKey]: entry }, agentStatusEpoch: 1 })
    const hook = renderHook(() => useActivityUnreadCount())
    expect(hook.result.current).toBe(1)
    const expiredAt = 2_001 + AGENT_STATUS_STALE_AFTER_MS
    act(() => {
      vi.setSystemTime(expiredAt)
      useAppStore.setState({ agentStatusEpoch: 2 })
    })
    expect(hook.result.current).toBe(0)
    act(() => {
      useAppStore.setState({
        agentStatusByPaneKey: { [paneKey]: { ...entry, updatedAt: expiredAt } }
      })
    })
    expect(hook.result.current).toBe(1)
    hook.unmount()
  })
})
