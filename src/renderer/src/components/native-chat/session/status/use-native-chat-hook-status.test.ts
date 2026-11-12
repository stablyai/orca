// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../../shared/agent-status/contracts/agent-status-freshness'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
  return { useAppStore: createTestStore() }
})

import { useAppStore } from '@/store'
import { useNativeChatHookStatus } from './use-native-chat-hook-status'
import { useNativeChatTerminalTurnTiming } from '../../conversation/turns/use-native-chat-terminal-turn-timing'

afterEach(() => {
  cleanup()
  for (const key of Array.from(useAppStore.getState().agentStatusByPaneKey.keys())) {
    useAppStore.getState().removeAgentStatus(key)
  }
  vi.useRealTimers()
})

it('preserves its pane status across another pane update and observes its own status and expiry', async () => {
  vi.useFakeTimers()
  const start = AGENT_STATUS_STALE_AFTER_MS * 10
  vi.setSystemTime(start)
  const messages: NativeChatMessage[] = [
    { id: 'turn', role: 'user', blocks: [], timestamp: start, source: 'transcript' }
  ]
  const store = useAppStore.getState()
  for (const paneKey of ['own:1', 'other:1']) {
    store.setAgentStatus(
      paneKey,
      { state: 'working', prompt: 'task', agentType: 'claude' },
      undefined,
      { updatedAt: start, evidenceObservedAt: start, turnStartedAt: start }
    )
  }
  const status = renderHook(() => useNativeChatHookStatus('own:1'))
  const timing = renderHook(() => useNativeChatTerminalTurnTiming('own:1', messages, false))
  act(() => {
    store.setAgentStatus('other:1', { state: 'done', prompt: 'task' })
    useAppStore.setState((state) => ({ agentStatusEpoch: state.agentStatusEpoch + 1 }))
  })
  expect(status.result.current[0]).toBe('working')
  act(() => {
    vi.setSystemTime(start + 5_000)
    store.setAgentStatus('own:1', { state: 'done', prompt: 'task' }, undefined, {
      turnStartedAt: start
    })
  })
  expect(status.result.current[0]).toBe('done')
  expect(timing.result.current.settledTurns.get('turn')).toEqual({
    startedAt: start,
    workedSeconds: 5
  })
  act(() => store.setAgentStatus('own:1', { state: 'working', prompt: 'next task' }))
  const entry = useAppStore.getState().agentStatusByPaneKey.get('own:1')
  await act(async () => {
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1)
  })
  expect(useAppStore.getState().agentStatusByPaneKey.get('own:1')).toBe(entry)
  expect(status.result.current[0]).toBeNull()
  expect(timing.result.current.settledTurns.get('turn')).toBeNull()
})
