import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { makePaneKey } from './stable-pane-id'

const PANE_KEY = makePaneKey('claude-elicitation', '11111111-1111-4111-8111-111111111111')

describe('Claude MCP elicitation', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  function claude(payload: Record<string, unknown>) {
    return normalizeHookPayload(state, 'claude', { paneKey: PANE_KEY, payload }, 'production')
      ?.payload
  }

  it('shows Needs You while an MCP elicitation is open, then returns to working', () => {
    expect(
      claude({ hook_event_name: 'UserPromptSubmit', prompt: 'approve the server' })?.state
    ).toBe('working')
    const tool = claude({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__server__tool',
      tool_use_id: 'toolu_1',
      tool_input: { query: 'x' }
    })
    expect(tool).toMatchObject({ state: 'working', toolName: 'mcp__server__tool' })

    const waiting = claude({
      hook_event_name: 'Elicitation',
      session_id: 'session-a',
      mcp_server_name: 'server',
      message: 'Allow this?',
      mode: 'form'
    })
    expect(waiting).toMatchObject({
      state: 'waiting',
      mainAgent: { state: 'waiting' },
      toolName: 'mcp__server__tool'
    })
    expect(waiting?.interactivePrompt).toBeUndefined()

    const resumed = claude({
      hook_event_name: 'ElicitationResult',
      session_id: 'session-a',
      action: 'accept',
      mode: 'form',
      elicitation_id: 'elicit_1'
    })
    expect(resumed).toMatchObject({
      state: 'working',
      mainAgent: { state: 'working' },
      toolName: 'mcp__server__tool'
    })
  })

  it('keeps the lead record when a child elicitation needs the person', () => {
    claude({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    const running = claude({ hook_event_name: 'SubagentStart', agent_id: 'a1' })
    const childWait = claude({
      hook_event_name: 'Elicitation',
      agent_id: 'a1',
      mcp_server_name: 'server',
      message: 'Allow this?'
    })
    expect(childWait).toMatchObject({
      state: 'waiting',
      mainAgent: { state: 'working', stateStartedAt: running?.mainAgent?.stateStartedAt }
    })
  })

  it('voids the previous session when an elicitation arrives for a replacement', () => {
    claude({
      hook_event_name: 'Stop',
      session_id: 'session-a',
      session_crons: [{ id: 'cron-1' }]
    })
    expect(state.claudeActiveSessionCronPaneKeys.has(PANE_KEY)).toBe(true)

    claude({
      hook_event_name: 'Elicitation',
      session_id: 'session-b',
      mcp_server_name: 'server',
      message: 'Allow this?'
    })

    expect(state.claudeActiveSessionCronPaneKeys.has(PANE_KEY)).toBe(false)
    expect(state.claudeSessionOwnerByPaneKey.get(PANE_KEY)).toBe('session-b')
  })
})
