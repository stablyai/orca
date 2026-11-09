import { describe, expect, it } from 'vitest'
import type { AgentHookEventPayload } from './listener-event'
import {
  isClaudePermissionSettledByReplay,
  retainClaudeSettledRequests
} from './claude-settled-permission-requests'

const base: AgentHookEventPayload = {
  paneKey: 'pane-1',
  tabId: 'tab-1',
  worktreeId: 'wt-1',
  connectionId: null,
  launchToken: 'launch-1',
  providerSession: { key: 'session_id', id: 'session-1' },
  payload: { state: 'working', agentType: 'claude', prompt: 'work' }
}
const ended = (toolUseId: string, extra: Partial<AgentHookEventPayload> = {}) => ({
  ...base,
  hookEventName: 'PostToolUse',
  toolUseId,
  ...extra
})

describe('retained Claude request settlements', () => {
  it('keeps an ended request across later hooks of the same run', () => {
    const afterEnd = retainClaudeSettledRequests(undefined, base, ended('tool-1'))
    const next = { ...base, hookEventName: 'PreToolUse', toolUseId: 'tool-2' }
    expect(retainClaudeSettledRequests(afterEnd, ended('tool-1'), next)).toEqual([
      { toolUseId: 'tool-1' }
    ])
  })

  it('keeps every request a batch end lists, so a reconnect can release a self-denied wait', () => {
    const batch = {
      ...base,
      hookEventName: 'PostToolBatch',
      claudeSettledRequests: [{ toolUseId: 'tool-1' }, { toolUseId: 'tool-denied' }]
    }
    const afterBatch = retainClaudeSettledRequests(undefined, base, batch)
    const next = { ...base, hookEventName: 'PreToolUse', toolUseId: 'tool-2' }
    expect(retainClaudeSettledRequests(afterBatch, batch, next)).toEqual([
      { toolUseId: 'tool-1' },
      { toolUseId: 'tool-denied' }
    ])
  })

  it.each([
    { launchToken: 'launch-2' },
    { providerSession: { key: 'session_id' as const, id: 'session-2' } },
    { agentPresence: { agent: 'claude' as const, ended: true as const } }
  ])('drops evidence across a run boundary: %j', (change) => {
    const retained = retainClaudeSettledRequests(undefined, base, ended('tool-1'))
    expect(
      retainClaudeSettledRequests(retained, ended('tool-1'), { ...base, ...change })
    ).toBeUndefined()
  })

  it('settles only the exact request, owner, host and run', () => {
    const waiting: AgentHookEventPayload = {
      ...base,
      connectionId: 'conn-1',
      hookEventName: 'PermissionRequest',
      toolUseId: 'tool-1',
      toolAgentId: 'child-1',
      toolAgentType: 'Explore',
      payload: { ...base.payload, state: 'waiting' }
    }
    const replay: AgentHookEventPayload = {
      ...base,
      connectionId: 'conn-1',
      isReplay: true,
      claudeSettledRequests: [
        { toolUseId: 'tool-1', toolAgentId: 'child-1', toolAgentType: 'Explore' }
      ]
    }
    expect(isClaudePermissionSettledByReplay(waiting, replay)).toBe(true)
    expect(isClaudePermissionSettledByReplay(waiting, { ...replay, isReplay: undefined })).toBe(
      false
    )
    expect(isClaudePermissionSettledByReplay({ ...waiting, toolAgentId: undefined }, replay)).toBe(
      false
    )
    expect(isClaudePermissionSettledByReplay(waiting, { ...replay, connectionId: 'conn-2' })).toBe(
      false
    )
    expect(isClaudePermissionSettledByReplay(waiting, { ...replay, launchToken: 'launch-2' })).toBe(
      false
    )
    expect(isClaudePermissionSettledByReplay({ ...waiting, toolUseId: 'tool-2' }, replay)).toBe(
      false
    )
    expect(isClaudePermissionSettledByReplay({ ...waiting, toolAgentType: 'Review' }, replay)).toBe(
      false
    )
    expect(
      isClaudePermissionSettledByReplay(waiting, {
        ...replay,
        providerSession: { key: 'session_id', id: 'session-2' }
      })
    ).toBe(false)
  })
})
