// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-freshness'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

import { useAppStore } from '@/store'
import { useNativeChatHookStatus } from './use-native-chat-hook-status'
import { useNativeChatTerminalTurnTiming } from './use-native-chat-terminal-turn-timing'

afterEach(() => {
  cleanup()
  for (const key of Object.keys(useAppStore.getState().agentStatusByPaneKey)) {
    useAppStore.getState().removeAgentStatus(key)
  }
  vi.useRealTimers()
})

it('keeps both pane hooks quiet for another pane while observing its own status and expiry', async () => {
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
  const renders = { status: 0, timing: 0 }
  const status = renderHook(() => {
    renders.status++
    return useNativeChatHookStatus('own:1')
  })
  const timing = renderHook(() => {
    renders.timing++
    return useNativeChatTerminalTurnTiming('own:1', messages, false)
  })
  const before = { ...renders }
  act(() => {
    store.setAgentStatus('other:1', { state: 'done', prompt: 'task' })
    useAppStore.setState((state) => ({ agentStatusEpoch: state.agentStatusEpoch + 1 }))
  })
  expect(renders).toEqual(before)
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
  expect(renders.status).toBeGreaterThan(before.status)
  expect(renders.timing).toBeGreaterThan(before.timing)
  act(() => store.setAgentStatus('own:1', { state: 'working', prompt: 'next task' }))
  const entry = useAppStore.getState().agentStatusByPaneKey['own:1']
  await act(async () => {
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1)
  })
  expect(useAppStore.getState().agentStatusByPaneKey['own:1']).toBe(entry)
  expect(status.result.current[0]).toBeNull()
  expect(timing.result.current.settledTurns.get('turn')).toBeNull()
})
