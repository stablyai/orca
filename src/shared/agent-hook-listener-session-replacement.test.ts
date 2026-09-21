import { describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { makePaneKey } from './stable-pane-id'

const LEAF_ID = '44444444-4444-4444-8444-444444444444'
const SESSION_A = 'session-a'
const SESSION_B = 'session-b'

function claudeEvent(
  state: HookListenerState,
  paneKey: string,
  payload: Record<string, unknown>
): ReturnType<typeof normalizeHookPayload> {
  return normalizeHookPayload(state, 'claude', { paneKey, payload }, 'production')
}

/** Close a turn for `sessionId`, carrying whatever inventory the caller wants folded. */
function stop(
  state: HookListenerState,
  paneKey: string,
  sessionId: string,
  extra: Record<string, unknown> = {}
): ReturnType<typeof normalizeHookPayload> {
  return claudeEvent(state, paneKey, {
    hook_event_name: 'Stop',
    session_id: sessionId,
    ...extra
  })
}

// A replacement session is the only evidence Orca gets for the exits Claude emits no terminating
// hook for (/clear, relaunch, resume). See PLAN-STA-4612 §4.1.
describe('Claude session replacement voids the replaced session claims', () => {
  it('voids a session cron gate held by the previous session', () => {
    const state = createHookListenerState()
    const paneKey = makePaneKey('cron-gate', LEAF_ID)

    stop(state, paneKey, SESSION_A, { session_crons: [{ id: 'cron-1' }] })
    expect(state.claudeActiveSessionCronPaneKeys.has(paneKey)).toBe(true)

    const replaced = stop(state, paneKey, SESSION_B)

    expect(state.claudeActiveSessionCronPaneKeys.has(paneKey)).toBe(false)
    expect(replaced?.payload.state).toBe('done')
  })

  it('voids a one-shot subagent the previous session was still running', () => {
    const state = createHookListenerState()
    const paneKey = makePaneKey('roster-void', LEAF_ID)

    claudeEvent(state, paneKey, {
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION_A,
      prompt: 'go'
    })
    claudeEvent(state, paneKey, {
      hook_event_name: 'SubagentStart',
      session_id: SESSION_A,
      agent_id: 'achild-0000000000000001'
    })
    expect(state.claudeSubagentRosterByPaneKey.get(paneKey)?.size).toBe(1)

    const replaced = stop(state, paneKey, SESSION_B)

    expect(state.claudeSubagentRosterByPaneKey.has(paneKey)).toBe(false)
    expect(replaced?.payload.state).toBe('done')
    expect(replaced?.payload.subagents ?? []).toEqual([])
  })

  it('keeps a confirmed teammate across the replacement — a lead swap cannot end an in-process teammate', () => {
    const state = createHookListenerState()
    const paneKey = makePaneKey('teammate-kept', LEAF_ID)

    // Anchor the owning session on a LEAD event first. Subagent/teammate events branch out of
    // normalizeClaudeEvent before the void ever runs, so without this the replacement below finds
    // no previous owner, returns early, and the assertion certifies a guard it never exercised.
    claudeEvent(state, paneKey, {
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION_A,
      prompt: 'spin up the team'
    })
    claudeEvent(state, paneKey, {
      hook_event_name: 'SubagentStart',
      session_id: SESSION_A,
      agent_id: 'arev-0000000000000001',
      agent_type: 'rev'
    })
    claudeEvent(state, paneKey, {
      hook_event_name: 'TeammateIdle',
      session_id: SESSION_A,
      teammate_name: 'rev'
    })
    claudeEvent(state, paneKey, {
      hook_event_name: 'SubagentStart',
      session_id: SESSION_A,
      agent_id: 'arev-0000000000000001',
      agent_type: 'rev'
    })
    const tracked = state.claudeSubagentRosterByPaneKey.get(paneKey)?.get('arev-0000000000000001')
    expect(tracked?.confirmedTeammate).toBe(true)
    expect(tracked?.state).toBe('working')
    expect(state.claudeSessionOwnerByPaneKey.get(paneKey)).toBe(SESSION_A)

    stop(state, paneKey, SESSION_B)

    // The replacement really happened, so the surviving row below is the guard's doing.
    expect(state.claudeSessionOwnerByPaneKey.get(paneKey)).toBe(SESSION_B)

    expect(
      state.claudeSubagentRosterByPaneKey.get(paneKey)?.get('arev-0000000000000001')?.state
    ).toBe('working')
  })

  it('KEEPS a running background-shell gate across the replacement', () => {
    // /clear keeps the Claude process alive, so a background shell can outlive the conversation and
    // the previous inventory is positive evidence it was running. Retiring it here would decide the
    // open live-shell product question inside this change. See PLAN-STA-4612 §6.3.
    const state = createHookListenerState()
    const paneKey = makePaneKey('bg-gate-kept', LEAF_ID)

    stop(state, paneKey, SESSION_A, {
      background_tasks: [{ type: 'bash', status: 'running', id: 'bash_1' }]
    })
    expect(state.claudeRunningNonAgentTaskPaneKeys.has(paneKey)).toBe(true)

    const replaced = claudeEvent(state, paneKey, {
      hook_event_name: 'PostToolUse',
      session_id: SESSION_B
    })

    expect(state.claudeRunningNonAgentTaskPaneKeys.has(paneKey)).toBe(true)
    expect(replaced?.payload.state).toBe('working')
  })

  it('voids nothing when the session id is unchanged', () => {
    const state = createHookListenerState()
    const paneKey = makePaneKey('same-session', LEAF_ID)

    stop(state, paneKey, SESSION_A, { session_crons: [{ id: 'cron-1' }] })
    const same = stop(state, paneKey, SESSION_A, { session_crons: [{ id: 'cron-1' }] })

    expect(state.claudeActiveSessionCronPaneKeys.has(paneKey)).toBe(true)
    expect(same?.payload.state).toBe('working')
  })

  it('voids nothing when a CHILD event carries a foreign session id', () => {
    // Claude has no equivalent of the Codex child-session guard, so a child payload's own
    // session_id reaches the same extraction path as the lead's.
    const state = createHookListenerState()
    const paneKey = makePaneKey('child-session', LEAF_ID)

    stop(state, paneKey, SESSION_A, { session_crons: [{ id: 'cron-1' }] })
    claudeEvent(state, paneKey, {
      hook_event_name: 'PostToolUse',
      session_id: 'child-session',
      agent_id: 'achild-0000000000000009'
    })

    expect(state.claudeActiveSessionCronPaneKeys.has(paneKey)).toBe(true)
    expect(state.claudeSessionOwnerByPaneKey.get(paneKey)).toBe(SESSION_A)
  })

  it('voids nothing when the event carries no session id', () => {
    const state = createHookListenerState()
    const paneKey = makePaneKey('no-session', LEAF_ID)

    stop(state, paneKey, SESSION_A, { session_crons: [{ id: 'cron-1' }] })
    stop(state, paneKey, '')

    expect(state.claudeActiveSessionCronPaneKeys.has(paneKey)).toBe(true)
    expect(state.claudeSessionOwnerByPaneKey.get(paneKey)).toBe(SESSION_A)
  })

  it('does not anchor an ignored compact SessionStart', () => {
    const state = createHookListenerState()
    const paneKey = makePaneKey('compact-owner', LEAF_ID)

    stop(state, paneKey, SESSION_A, { session_crons: [{ id: 'cron-1' }] })
    expect(
      claudeEvent(state, paneKey, {
        hook_event_name: 'SessionStart',
        session_id: SESSION_B,
        source: 'compact'
      })
    ).toBeNull()

    stop(state, paneKey, SESSION_B)

    expect(state.claudeActiveSessionCronPaneKeys.has(paneKey)).toBe(false)
  })

  it('leaves the lead-state record to the incoming fold rather than deleting it', () => {
    const state = createHookListenerState()
    const paneKey = makePaneKey('lead-untouched', LEAF_ID)

    stop(state, paneKey, SESSION_A)
    claudeEvent(state, paneKey, {
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION_B,
      prompt: 'new conversation'
    })

    expect(state.claudeLeadStateByPaneKey.get(paneKey)?.state).toBe('working')
  })
})
