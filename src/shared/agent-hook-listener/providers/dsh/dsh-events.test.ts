import { describe, expect, it } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import { normalizeAndAccept } from '../../normalization/agent-hook-listener-test-harness'

// @deepseek-ai/dsh-hooks-claude-code 0.2.2-rc.3 stamps every hook with the acting agent's own session_id.
const LEAD_ID = '9478e2d8-29bc-4009-ab32-657efa2bd763'
const CHILD_ID = '1471f5e6-bd60-41a2-bfcf-c9086dbd4092'

function event(
  sessionId: string,
  name: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    transcript_path: '',
    cwd: '/tmp/ws',
    session_id: sessionId,
    hook_event_name: name,
    ...extra
  }
}

describe('normalizeDshEvent', () => {
  it('keeps a subagent from finishing the lead pane, during and after the lead turn', () => {
    const state = createHookListenerState()
    normalizeAndAccept(state, 'dsh', event(LEAD_ID, 'SessionStart', { source: 'startup' }))
    normalizeAndAccept(state, 'dsh', event(LEAD_ID, 'UserPromptSubmit', { prompt: 'delegate' }))
    normalizeAndAccept(state, 'dsh', event(LEAD_ID, 'PreToolUse', { tool_name: 'spawn_agent' }))

    // The bridge awaits the child's SessionStart before it emits SubagentStart.
    expect(
      normalizeAndAccept(state, 'dsh', event(CHILD_ID, 'SessionStart', { source: 'startup' }))
    ).toBeNull()
    const subagent = { agent_id: CHILD_ID, agent_type: 'general-purpose' }
    expect(normalizeAndAccept(state, 'dsh', event(CHILD_ID, 'SubagentStart', subagent))).toBeNull()
    expect(
      normalizeAndAccept(state, 'dsh', event(CHILD_ID, 'UserPromptSubmit', { prompt: 'task' }))
    ).toBeNull()
    expect(normalizeAndAccept(state, 'dsh', event(CHILD_ID, 'Stop'))).toBeNull()

    const leadStop = normalizeAndAccept(state, 'dsh', event(LEAD_ID, 'Stop'))
    expect(leadStop?.payload.state).toBe('done')
    expect(leadStop?.payload.prompt).toBe('delegate')
    expect(leadStop?.providerSession?.id).toBe(LEAD_ID)

    // A background child keeps running after the lead's turn ends.
    expect(
      normalizeAndAccept(state, 'dsh', event(CHILD_ID, 'PreToolUse', { tool_name: 'bash' }))
    ).toBeNull()
    expect(normalizeAndAccept(state, 'dsh', event(CHILD_ID, 'Stop'))).toBeNull()
  })
})
