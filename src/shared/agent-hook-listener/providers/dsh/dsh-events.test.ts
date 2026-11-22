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

    // The lead ends its turn while the background child still runs.
    const leadStop = normalizeAndAccept(state, 'dsh', event(LEAD_ID, 'Stop'))
    expect(leadStop?.payload.state).toBe('working')
    expect(leadStop?.payload.mainAgent?.state).toBe('done')
    expect(leadStop?.payload.prompt).toBe('delegate')
    expect(leadStop?.providerSession?.id).toBe(LEAD_ID)

    expect(
      normalizeAndAccept(state, 'dsh', event(CHILD_ID, 'PreToolUse', { tool_name: 'bash' }))
    ).toBeNull()
    expect(normalizeAndAccept(state, 'dsh', event(CHILD_ID, 'Stop'))).toBeNull()
    expect(normalizeAndAccept(state, 'dsh', event(CHILD_ID, 'SubagentStop', subagent))).toBeNull()

    // DSH wakes the lead with the child's result in a new turn.
    const resultTurn = normalizeAndAccept(
      state,
      'dsh',
      event(LEAD_ID, 'UserPromptSubmit', { prompt: 'subagent result' })
    )
    expect(resultTurn?.payload.state).toBe('working')
    expect(normalizeAndAccept(state, 'dsh', event(LEAD_ID, 'Stop'))?.payload.state).toBe('done')
  })

  it('holds the lead until every running child stops', () => {
    const state = createHookListenerState()
    const otherChildId = '5d0c7a41-8f2e-4b6a-9c3d-2e1f0a9b8c7d'
    normalizeAndAccept(state, 'dsh', event(LEAD_ID, 'UserPromptSubmit', { prompt: 'fan out' }))
    for (const childId of [CHILD_ID, otherChildId]) {
      normalizeAndAccept(state, 'dsh', event(childId, 'SessionStart', { source: 'startup' }))
      normalizeAndAccept(state, 'dsh', event(childId, 'SubagentStart', { agent_id: childId }))
    }
    expect(normalizeAndAccept(state, 'dsh', event(LEAD_ID, 'Stop'))?.payload.state).toBe('working')

    // A compact restarts the lead's own session; its children keep running.
    normalizeAndAccept(state, 'dsh', event(LEAD_ID, 'SessionStart', { source: 'compact' }))
    normalizeAndAccept(state, 'dsh', event(LEAD_ID, 'UserPromptSubmit', { prompt: 'continue' }))
    expect(normalizeAndAccept(state, 'dsh', event(LEAD_ID, 'Stop'))?.payload.state).toBe('working')

    normalizeAndAccept(state, 'dsh', event(CHILD_ID, 'SubagentStop', { agent_id: CHILD_ID }))
    normalizeAndAccept(state, 'dsh', event(LEAD_ID, 'UserPromptSubmit', { prompt: 'first result' }))
    expect(normalizeAndAccept(state, 'dsh', event(LEAD_ID, 'Stop'))?.payload.state).toBe('working')

    normalizeAndAccept(
      state,
      'dsh',
      event(otherChildId, 'SubagentStop', { agent_id: otherChildId })
    )
    normalizeAndAccept(state, 'dsh', event(LEAD_ID, 'UserPromptSubmit', { prompt: 'last result' }))
    expect(normalizeAndAccept(state, 'dsh', event(LEAD_ID, 'Stop'))?.payload.state).toBe('done')
  })

  it('lets a new lead session replace a lead held by its children', () => {
    const state = createHookListenerState()
    const nextLeadId = 'c2b7e9d0-4a1f-4e3b-8d6c-7f5a3b2e1d09'
    normalizeAndAccept(state, 'dsh', event(LEAD_ID, 'UserPromptSubmit', { prompt: 'delegate' }))
    normalizeAndAccept(state, 'dsh', event(CHILD_ID, 'SessionStart', { source: 'startup' }))
    normalizeAndAccept(state, 'dsh', event(CHILD_ID, 'SubagentStart', { agent_id: CHILD_ID }))
    expect(normalizeAndAccept(state, 'dsh', event(LEAD_ID, 'Stop'))?.payload.state).toBe('working')

    const replaced = normalizeAndAccept(
      state,
      'dsh',
      event(nextLeadId, 'SessionStart', { source: 'clear' })
    )
    expect(replaced?.payload.state).toBe('done')
    expect(replaced?.providerSession?.id).toBe(nextLeadId)
    normalizeAndAccept(state, 'dsh', event(nextLeadId, 'UserPromptSubmit', { prompt: 'next' }))
    expect(normalizeAndAccept(state, 'dsh', event(nextLeadId, 'Stop'))?.payload.state).toBe('done')
  })
})
