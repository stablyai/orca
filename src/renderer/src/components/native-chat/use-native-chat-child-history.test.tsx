// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { useNativeChatChildHistory } from './use-native-chat-child-history'

afterEach(cleanup)
const row = (id: string): NativeChatMessage => ({
  id,
  role: 'assistant',
  blocks: [{ type: 'text', text: id }],
  source: 'transcript',
  timestamp: 1
})

it('loads parent pages only until the child assignment is present and never repeats an unchanged anchor', () => {
  const loadEarlier = vi.fn(async () => 'applied' as const)
  const initial = {
    scopeKey: 'session:child',
    agentId: 'child',
    messages: [row('latest')],
    hasMore: true,
    loading: false,
    enabled: true,
    loadEarlier
  }
  const { rerender } = renderHook(useNativeChatChildHistory, { initialProps: initial })
  expect(loadEarlier).toHaveBeenCalledTimes(1)
  rerender({ ...initial, messages: [...initial.messages] })
  expect(loadEarlier).toHaveBeenCalledTimes(1)
  rerender({ ...initial, messages: [row('older'), ...initial.messages], loading: true })
  expect(loadEarlier).toHaveBeenCalledTimes(1)
  rerender({ ...initial, messages: [row('older'), ...initial.messages] })
  expect(loadEarlier).toHaveBeenCalledTimes(2)
  const assignment: NativeChatMessage = {
    ...row('assignment'),
    blocks: [
      {
        type: 'tool-call',
        callId: 'call',
        name: 'spawn_agent',
        state: 'completed',
        input: { agents: ['child'], prompt: 'Complete original task' }
      }
    ]
  }
  rerender({ ...initial, messages: [assignment, ...initial.messages] })
  expect(loadEarlier).toHaveBeenCalledTimes(2)
  rerender({ ...initial, messages: [row('hidden-older')], enabled: false })
  expect(loadEarlier).toHaveBeenCalledTimes(2)
})
