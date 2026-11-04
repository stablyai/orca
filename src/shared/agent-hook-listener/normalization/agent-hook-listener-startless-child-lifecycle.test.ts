import { describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeHookPayload } from './normalize-hook-payload'
import { makePaneKey } from '../../stable-pane-id'

const LEAF_ID = '22222222-2222-4222-8222-222222222222'

function claudeEvent(
  state: HookListenerState,
  paneKey: string,
  payload: Record<string, unknown>
): ReturnType<typeof normalizeHookPayload> {
  return normalizeHookPayload(state, 'claude', { paneKey, payload }, 'production')
}

// Restarts lose the in-memory lead cache while surviving sessions can still emit child hooks.
describe('Claude child lifecycle events with no cached lead state', () => {
  it('resolves a first-event child wait back to working when that child stops', () => {
    const state = createHookListenerState()
    const paneKey = makePaneKey('startless-wait-stop', LEAF_ID)

    expect(
      claudeEvent(state, paneKey, {
        hook_event_name: 'PermissionRequest',
        agent_id: 'a0000000000000007',
        tool_name: 'Bash'
      })?.payload.state
    ).toBe('waiting')

    const stopped = claudeEvent(state, paneKey, {
      hook_event_name: 'SubagentStop',
      agent_id: 'a0000000000000007'
    })

    expect(stopped?.payload.state).toBe('working')
  })
})
