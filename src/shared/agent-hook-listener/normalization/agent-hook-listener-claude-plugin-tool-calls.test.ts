import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './normalize-hook-payload'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { makePaneKey } from '../../workspace-layout/stable-pane-id'

const PANE_KEY = makePaneKey('claude-plugin-calls', '11111111-1111-4111-8111-111111111111')
const PLUGIN_IDS = ['toolu_plugin_0a1b', 'toolu_plugin_agent_0a1b']

describe('Claude plugin-made tool calls', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  function claude(payload: Record<string, unknown>) {
    return normalizeHookPayload(state, 'claude', { paneKey: PANE_KEY, payload }, 'production')
      ?.payload
  }

  function toolEvents(toolUseId: string, extra: Record<string, unknown> = {}) {
    const call = { tool_name: 'mcp__plugin__sync', tool_use_id: toolUseId, ...extra }
    return [
      claude({ hook_event_name: 'PreToolUse', ...call }),
      claude({ hook_event_name: 'PostToolUse', ...call, tool_response: {} })
    ]
  }

  // PermissionRequest carries no tool_use_id; the listener names it from the matching PreToolUse.
  function promptedStates(toolUseId: string, extra: Record<string, unknown> = {}) {
    const call = { tool_name: 'Bash', tool_input: { command: 'ls' }, ...extra }
    return [
      claude({ hook_event_name: 'PreToolUse', ...call, tool_use_id: toolUseId }),
      claude({ hook_event_name: 'PermissionRequest', ...call }),
      claude({ hook_event_name: 'PostToolUse', ...call, tool_use_id: toolUseId, tool_response: {} })
    ].map((payload) => payload?.state)
  }

  it.each(PLUGIN_IDS)(
    'keeps a finished turn done when a plugin call (%s) runs after Stop',
    (toolUseId) => {
      claude({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
      expect(claude({ hook_event_name: 'Stop' })?.state).toBe('done')

      const done = { state: 'done', mainAgent: { state: 'done' }, subagents: undefined }
      expect(toolEvents(toolUseId)).toMatchObject([done, done])
      expect(toolEvents(toolUseId, { agent_id: 'a1b2c3' })).toMatchObject([done, done])

      // A model call after Stop is a resumed turn (e.g. a background task woke it) and still works.
      expect(toolEvents('toolu_01Abc')[0]).toMatchObject({
        state: 'working',
        mainAgent: { state: 'working' }
      })
      expect(claude({ hook_event_name: 'Stop' })?.state).toBe('done')
      expect(claude({ hook_event_name: 'UserPromptSubmit', prompt: 'again' })?.state).toBe(
        'working'
      )
    }
  )

  it.each(PLUGIN_IDS)('shows a plugin call (%s) prompt mid-turn and clears it', (toolUseId) => {
    claude({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
    expect(promptedStates(toolUseId)).toEqual(['working', 'waiting', 'working'])
    expect(claude({ hook_event_name: 'Stop' })?.state).toBe('done')
  })

  it.each(PLUGIN_IDS)('clears a plugin call (%s) prompt made for an agent', (toolUseId) => {
    claude({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
    expect(promptedStates(toolUseId, { agent_id: 'a1b2c3' })).toEqual([
      'working',
      'waiting',
      'working'
    ])
  })

  it('shows a plugin question as a wait and clears it on its result', () => {
    claude({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' })
    const call = { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_plugin_q1', tool_input: {} }
    expect(claude({ hook_event_name: 'PreToolUse', ...call })?.state).toBe('waiting')
    expect(claude({ hook_event_name: 'PostToolUse', ...call, tool_response: {} })?.state).toBe(
      'working'
    )
  })
})
