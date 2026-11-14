import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './normalize-hook-payload'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { makePaneKey } from '../../workspace-layout/stable-pane-id'

const PANE_KEY = makePaneKey('claude-model', '22222222-2222-4222-8222-222222222222')

describe('Claude hook model', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  function claude(payload: Record<string, unknown>) {
    return normalizeHookPayload(state, 'claude', { paneKey: PANE_KEY, payload }, 'production')
      ?.payload
  }

  it('publishes the SessionStart model and keeps it when later events omit it', () => {
    expect(
      claude({
        hook_event_name: 'SessionStart',
        source: 'startup',
        model: 'claude-sonnet-5'
      })
    ).toMatchObject({ state: 'done', model: 'claude-sonnet-5', sessionBoundary: true })

    expect(claude({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' })?.model).toBe(
      'claude-sonnet-5'
    )
    expect(
      claude({ hook_event_name: 'SubagentStart', agent_id: 'agent-1', agent_type: 'worker' })?.model
    ).toBe('claude-sonnet-5')
    expect(claude({ hook_event_name: 'Stop' })?.model).toBe('claude-sonnet-5')
  })

  it('replaces the model when a later lead event reports a new one and keeps it when a new session omits it', () => {
    claude({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-sonnet-5' })
    expect(
      claude({ hook_event_name: 'UserPromptSubmit', prompt: 'switch', model: 'claude-opus-4-7' })
        ?.model
    ).toBe('claude-opus-4-7')
    expect(claude({ hook_event_name: 'SessionStart', source: 'clear' })?.model).toBe(
      'claude-opus-4-7'
    )
    expect(
      claude({ hook_event_name: 'SessionStart', source: 'startup', model: '   ' })?.model
    ).toBe('claude-opus-4-7')
  })
})
