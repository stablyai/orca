import { describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  normalizeHookPayload,
  type HookListenerState
} from './agent-hook-listener'
import { MAX_AGENT_HOOK_STATUS_CACHE_PANES } from './agent-hook-status-cache'
import { makePaneKey } from './stable-pane-id'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function claudeEvent(
  state: HookListenerState,
  paneKey: string,
  payload: Record<string, unknown>
): ReturnType<typeof normalizeHookPayload> {
  return normalizeHookPayload(state, 'claude', { paneKey, payload }, 'production')
}

describe('Claude hook roster retention', () => {
  it('does not retain rosters for malformed lifecycle events across unique panes', () => {
    const state = createHookListenerState()
    for (let index = 0; index <= MAX_AGENT_HOOK_STATUS_CACHE_PANES; index += 1) {
      const paneKey = makePaneKey(`malformed-${index}`, LEAF_ID)
      expect(claudeEvent(state, paneKey, { hook_event_name: 'TeammateIdle' })).toBeNull()
    }

    expect(state.lastStatusByPaneKey.size).toBe(0)
    expect(state.claudeSubagentRosterByPaneKey.size).toBe(0)
  })

  it('preserves ordinary teammate lifecycle updates', () => {
    const state = createHookListenerState()
    const paneKey = makePaneKey('valid-lifecycle', LEAF_ID)
    claudeEvent(state, paneKey, { hook_event_name: 'UserPromptSubmit', prompt: 'spawn reviewer' })
    claudeEvent(state, paneKey, { hook_event_name: 'Stop', background_tasks: [] })

    const started = claudeEvent(state, paneKey, {
      hook_event_name: 'SubagentStart',
      agent_id: 'areviewer-6d3cb5b52120b7bf',
      agent_type: 'security-reviewer'
    })
    expect(started?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'areviewer-6d3cb5b52120b7bf', state: 'working' })
    ])

    const idled = claudeEvent(state, paneKey, {
      hook_event_name: 'TeammateIdle',
      teammate_name: 'reviewer'
    })
    expect(idled?.payload.state).toBe('done')
    expect(idled?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'areviewer-6d3cb5b52120b7bf', state: 'idle' })
    ])
    expect(state.claudeSubagentRosterByPaneKey.size).toBe(1)
  })
})
