import { describe, expect, it } from 'vitest'
import type { AgentHookEventPayload } from './listener-event'
import {
  isClaudePermissionSettledByReplay,
  MAX_CLAUDE_SETTLED_REQUESTS,
  readClaudeSettledRequests,
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

  it('records a failure and keeps the child owner exact', () => {
    expect(
      retainClaudeSettledRequests(
        undefined,
        base,
        ended('tool-1', {
          hookEventName: 'PostToolUseFailure',
          toolAgentId: 'child-1',
          toolAgentType: 'Explore'
        })
      )
    ).toEqual([{ toolUseId: 'tool-1', toolAgentId: 'child-1', toolAgentType: 'Explore' }])
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

  it('bounds the list and keeps the newest', () => {
    let retained = retainClaudeSettledRequests(undefined, base, ended('tool-0'))
    for (let index = 1; index < 40; index++) {
      retained = retainClaudeSettledRequests(retained, base, ended(`tool-${index}`))
    }
    expect(retained).toHaveLength(MAX_CLAUDE_SETTLED_REQUESTS)
    expect(retained).toEqual(
      Array.from({ length: MAX_CLAUDE_SETTLED_REQUESTS }, (_, index) => ({
        toolUseId: `tool-${40 - MAX_CLAUDE_SETTLED_REQUESTS + index}`
      }))
    )
  })

  it('rejects a malformed or oversized wire list whole', () => {
    expect(readClaudeSettledRequests([{ toolUseId: ' tool-1 ' }])).toEqual([
      { toolUseId: 'tool-1' }
    ])
    expect(readClaudeSettledRequests([{ toolUseId: 'tool-1' }, { toolUseId: '' }])).toBeUndefined()
    expect(readClaudeSettledRequests([{ toolUseId: 'tool-1', toolAgentId: 7 }])).toBeUndefined()
    expect(
      readClaudeSettledRequests(
        Array.from({ length: MAX_CLAUDE_SETTLED_REQUESTS + 1 }, (_, i) => ({ toolUseId: `t${i}` }))
      )
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
