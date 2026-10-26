// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

import { useAppStore } from '@/store'
import { getAgentStatusOwner } from '@/store/agent-status-commit'
import { flushMicrotasks } from '@/store/slices/agent-status-test-harness'
import { useNativeChatHookStatus, resolveNativeChatHookState } from './use-native-chat-hook-status'
import { useNativeChatTerminalTurnTiming } from './use-native-chat-terminal-turn-timing'

describe('resolveNativeChatHookState', () => {
  const now = 1_000_000

  it('does not treat a restored working row as live activity', () => {
    expect(
      resolveNativeChatHookState(
        {
          state: 'working',
          workingMode: undefined,
          updatedAt: now,
          restoredUnconfirmed: true
        },
        now
      )
    ).toBeNull()
  })

  it('keeps confirmed working activity live', () => {
    expect(
      resolveNativeChatHookState(
        {
          state: 'working',
          workingMode: undefined,
          updatedAt: now,
          restoredUnconfirmed: false
        },
        now
      )
    ).toBe('working')
  })

  it('continues to suppress monitoring rows', () => {
    expect(
      resolveNativeChatHookState(
        {
          state: 'working',
          workingMode: 'monitoring',
          updatedAt: now,
          restoredUnconfirmed: false
        },
        now
      )
    ).toBeNull()
  })

  it('does not keep an expired working row live', () => {
    expect(
      resolveNativeChatHookState(
        {
          state: 'working',
          workingMode: undefined,
          updatedAt: now - 30 * 60 * 1000 - 1,
          restoredUnconfirmed: false
        },
        now
      )
    ).toBeNull()
  })
})

afterEach(async () => {
  cleanup()
  for (const key of Object.keys(getAgentStatusOwner(useAppStore).getSnapshot())) {
    useAppStore.getState().removeAgentStatus(key)
  }
  await flushMicrotasks()
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.useRealTimers()
})

describe('native semantic freshness subscriptions', () => {
  it.each([10, 100])(
    'isolates both hooks when one of %i panes finishes, preserving own work and silent TTL',
    async (count) => {
      vi.useFakeTimers()
      const start = count * AGENT_STATUS_STALE_AFTER_MS * 10
      vi.setSystemTime(start)
      const messages: NativeChatMessage[] = [
        { id: 'turn', role: 'user', blocks: [], timestamp: start, source: 'transcript' }
      ]
      const keys = Array.from({ length: count }, (_, index) => `native-${index}:1`)
      useAppStore.getState().setAgentStatuses(
        keys.map((paneKey) => ({
          kind: 'status' as const,
          paneKey,
          payload: { state: 'working' as const, prompt: 'task', agentType: 'claude' as const },
          timing: { updatedAt: start, evidenceObservedAt: start, turnStartedAt: start }
        }))
      )
      const statusRenders = keys.map(() => 0)
      const timingRenders = keys.map(() => 0)
      // Separate mounts make each hook's freshness and render obligations independent.
      const statuses = keys.map((key, index) =>
        renderHook(() => {
          statusRenders[index]++
          return useNativeChatHookStatus(key)
        })
      )
      const timings = keys.map((key, index) =>
        renderHook(() => {
          timingRenders[index]++
          return useNativeChatTerminalTurnTiming(key, messages, false)
        })
      )
      const owner = getAgentStatusOwner(useAppStore)
      const quietRow = owner.getEntry(keys[1])
      const quietState = statuses[1].result.current
      const quietTiming = timings[1].result.current
      const stateBefore = [...statusRenders]
      const timeBefore = [...timingRenders]
      act(() => {
        vi.setSystemTime(start + 5000)
        useAppStore.getState().setAgentStatus(
          keys[0],
          {
            state: 'done',
            prompt: 'task',
            agentType: 'claude',
            sessionBoundary: false
          },
          undefined,
          { updatedAt: start + 5000, evidenceObservedAt: start + 5000, turnStartedAt: start }
        )
      })
      expect(statuses[0].result.current[0]).toBe('done')
      expect(timings[0].result.current.settledTurns.get('turn')).toEqual({
        startedAt: start,
        workedSeconds: 5
      })
      expect(statusRenders.slice(1)).toEqual(stateBefore.slice(1))
      expect(timingRenders.slice(1)).toEqual(timeBefore.slice(1))
      expect(statuses[1].result.current).toBe(quietState)
      expect(timings[1].result.current).toBe(quietTiming)
      expect(owner.getEntry(keys[1])).toBe(quietRow)
      act(() => {
        useAppStore.setState({ activeWorktreeId: 'unrelated draft companion' })
      })
      expect(statusRenders.slice(1)).toEqual(stateBefore.slice(1))
      expect(timingRenders.slice(1)).toEqual(timeBefore.slice(1))
      await act(async () => {
        await flushMicrotasks()
        vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1)
      })
      expect(owner.getEntry(keys[1])).toBe(quietRow)
      expect(statuses[1].result.current[0]).toBeNull()
      expect(timings[1].result.current.settledTurns.has('turn')).toBe(true)
      expect(timings[1].result.current.settledTurns.get('turn')).toBeNull()
      const resumedAt = Date.now()
      act(() => {
        useAppStore.getState().setAgentStatus(keys[1], { state: 'done', prompt: 'old task' })
        useAppStore.getState().setAgentStatus(
          keys[1],
          {
            state: 'working',
            prompt: 'new task',
            agentType: 'claude',
            subagents: [{ id: 'child', state: 'working', startedAt: resumedAt }]
          },
          undefined,
          { updatedAt: resumedAt, evidenceObservedAt: resumedAt }
        )
      })
      expect(statuses[1].result.current).toEqual(['working', resumedAt, true])
      expect(timings[1].result.current.settledTurns.has('turn')).toBe(false)
      const activeTiming = renderHook(() =>
        useNativeChatTerminalTurnTiming(keys[1], messages, true)
      )
      expect(activeTiming.result.current.workingStartedAt).toBe(resumedAt)
    }
  )
})
