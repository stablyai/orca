import { describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
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

  it('does not retain rosters for unknown child endings across unique panes', () => {
    const state = createHookListenerState()
    for (let index = 0; index <= MAX_AGENT_HOOK_STATUS_CACHE_PANES; index += 1) {
      const paneKey = makePaneKey(`unknown-stop-${index}`, LEAF_ID)
      expect(
        claudeEvent(state, paneKey, {
          hook_event_name: 'SubagentStop',
          agent_id: 'a0000000000000001'
        })
      ).toBeNull()
    }

    expect(state.lastStatusByPaneKey.size).toBe(0)
    expect(state.claudeSubagentRosterByPaneKey.size).toBe(0)
  })
})
