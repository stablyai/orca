// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'

const { hostForks, beginLaunch } = vi.hoisted(() => ({
  hostForks: { current: true },
  beginLaunch: vi.fn()
}))
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapability: () => hostForks.current
}))
vi.mock('@/lib/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: beginLaunch
}))
// The verdict passes through as the plan, so the launch is asserted on what was asked for.
vi.mock('@/lib/agent-session-launch-plan', () => ({
  adoptAgentSessionLaunchVerdict: (verdict: unknown) => verdict
}))

import { useNativeChatFork } from './use-native-chat-fork'

function row(itemId: string, body: unknown, turnItemId?: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fork rows are chosen from a row's id, body and turn scope alone.
  return {
    itemId,
    body,
    ...(turnItemId ? { turnScope: { kind: 'turn', turnItemId } } : {})
  } as AgentJournalRenderItem
}

const ITEMS = [
  row('turn-a', { kind: 'turn', turnId: 'a', state: 'completed', outcome: 'success' }),
  row(
    'a-answer',
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'done' }] },
    'turn-a'
  )
]
const PANE = {
  sessionId: 'codex_parent',
  agent: 'codex',
  target: { kind: 'environment', environmentId: 'server-1' }
} as const

describe('useNativeChatFork', () => {
  beforeEach(() => {
    hostForks.current = true
    beginLaunch.mockReset()
  })

  it('forks the clicked row’s chat on the host that holds it', () => {
    const { result } = renderHook(() => useNativeChatFork(PANE, 'wt-1', ITEMS))

    expect([...(result.current?.rows ?? [])]).toEqual(['a-answer'])
    result.current?.fork('a-answer')

    expect(beginLaunch).toHaveBeenCalledWith({
      plan: expect.objectContaining({
        route: 'structured-native-chat',
        agent: 'codex',
        worktreeId: 'wt-1',
        executionHostId: 'runtime:server-1',
        forkFrom: { sessionId: 'codex_parent', itemId: 'a-answer' }
      }),
      hooks: {}
    })
  })

  it.each([
    ['the host predates forking', () => (hostForks.current = false), PANE, 'wt-1'],
    ['the agent has no provider fork', () => {}, { ...PANE, agent: 'pi' }, 'wt-1'],
    ['the chat’s workspace is not known yet', () => {}, PANE, null]
  ] as const)('offers nothing when %s', (_, arrange, pane, worktreeId) => {
    arrange()

    const { result } = renderHook(() => useNativeChatFork(pane, worktreeId, ITEMS))

    expect(result.current).toBeUndefined()
  })
})
