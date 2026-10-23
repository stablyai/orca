import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeAndAccept } from '../../agent-hook-listener-test-harness'

// Payload shape copied from a live run of @deepseek-ai/dsh-hooks-claude-code 0.1.5-rc.3
// mounted through $DSH_HOME/cordis.patch.yml: `session_id`, an always-empty
// `transcript_path`, `cwd`, `hook_event_name`, plus the per-event fields.
const SESSION_ID = '9478e2d8-29bc-4009-ab32-657efa2bd763'
const CHILD_SESSION_ID = 'b1c4fb80-4f12-4a6f-9a68-7c0d5f0f5a12'
const NEW_SESSION_ID = '0d6f8a52-3c39-4a3c-9f0c-6a8f1f4b7e21'

const base = { transcript_path: '', cwd: '/tmp/ws', session_id: SESSION_ID }

function event(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...base, hook_event_name: name, ...extra }
}

describe('normalizeDshEvent', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it('reports a prompt as working and a stop as done', () => {
    const submitted = normalizeAndAccept(
      state,
      'dsh',
      event('UserPromptSubmit', { prompt: 'fix the flaky test' })
    )
    expect(submitted?.payload.state).toBe('working')
    expect(submitted?.payload.agentType).toBe('dsh')
    expect(submitted?.payload.prompt).toBe('fix the flaky test')

    const stopped = normalizeAndAccept(state, 'dsh', event('Stop', { stop_hook_active: false }))
    expect(stopped?.payload.state).toBe('done')
    // The prompt is carried across the turn so a finished row still names the work.
    expect(stopped?.payload.prompt).toBe('fix the flaky test')
  })

  it('lands an idle row on SessionStart', () => {
    const started = normalizeAndAccept(state, 'dsh', event('SessionStart', { source: 'startup' }))
    expect(started?.payload.state).toBe('done')
    expect(started?.payload.agentType).toBe('dsh')
    expect(started?.payload.sessionBoundary).toBe(true)
    const stopped = normalizeAndAccept(state, 'dsh', event('Stop', { stop_hook_active: false }))
    expect(stopped?.payload.sessionBoundary).toBeUndefined()
  })

  it('treats an ordinary tool as working and surfaces its name', () => {
    normalizeAndAccept(state, 'dsh', event('UserPromptSubmit', { prompt: 'read the readme' }))
    const pre = normalizeAndAccept(
      state,
      'dsh',
      event('PreToolUse', {
        tool_name: 'read',
        tool_input: { path: 'README.md' },
        tool_use_id: 'call-1'
      })
    )
    expect(pre?.payload.state).toBe('working')
    expect(pre?.payload.toolName).toBe('read')
  })

  it('reports ask_user_question as waiting and its answer as working again', () => {
    normalizeAndAccept(state, 'dsh', event('UserPromptSubmit', { prompt: 'pick a colour' }))
    const asked = normalizeAndAccept(
      state,
      'dsh',
      event('PreToolUse', {
        tool_name: 'ask_user_question',
        tool_input: {
          questions: [{ header: 'Colour', question: 'Which one?', options: [{ label: 'Blue' }] }]
        },
        tool_use_id: 'call-2'
      })
    )
    // Why this matters: DSH's bridge has no Notification/PermissionRequest event, so the
    // ask-the-user tool is the only structured signal that a pane needs the user.
    expect(asked?.payload.state).toBe('waiting')
    expect(asked?.payload.interactivePrompt).toContain('Which one?')

    const answered = normalizeAndAccept(
      state,
      'dsh',
      event('PostToolUse', {
        tool_name: 'ask_user_question',
        tool_use_id: 'call-2',
        tool_response: 'Blue'
      })
    )
    expect(answered?.payload.state).toBe('working')
  })

  it('ignores subagent lifecycle events', () => {
    normalizeAndAccept(state, 'dsh', event('UserPromptSubmit', { prompt: 'delegate this' }))
    const done = normalizeAndAccept(state, 'dsh', event('Stop', {}))
    expect(done?.payload.state).toBe('done')

    // Subagent edges name the child (`agent_id` and `session_id`) under a constant
    // `general-purpose` agent_type; a child that outlives the lead's Stop must not flip the
    // finished pane back to working (the Muse regression in #22216).
    for (const name of ['SubagentStart', 'SubagentStop']) {
      expect(
        normalizeAndAccept(state, 'dsh', {
          ...base,
          session_id: CHILD_SESSION_ID,
          hook_event_name: name,
          agent_id: CHILD_SESSION_ID,
          agent_type: 'general-purpose'
        })
      ).toBeNull()
    }
  })
})

// The bridge (0.2.0-rc.2) fires SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop for
// every in-process agent, each stamped with that agent's OWN session id. Only SubagentStart and
// SubagentStop say which ids are children, and a child's SessionStart always lands before them.
describe('normalizeDshEvent with in-process subagents', () => {
  let state: HookListenerState

  const child = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    event(name, { session_id: CHILD_SESSION_ID, ...extra })
  const subagentEdge = (name: 'SubagentStart' | 'SubagentStop'): Record<string, unknown> =>
    child(name, { agent_id: CHILD_SESSION_ID, agent_type: 'general-purpose' })

  beforeEach(() => {
    state = createHookListenerState()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-12T10:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the lead session and turn through a child run, in the order the bridge posts', () => {
    const accepted = [
      normalizeAndAccept(state, 'dsh', event('SessionStart', { source: 'startup' })),
      normalizeAndAccept(state, 'dsh', event('UserPromptSubmit', { prompt: 'delegate the audit' })),
      normalizeAndAccept(
        state,
        'dsh',
        event('PreToolUse', { tool_name: 'subagent', tool_use_id: 'call-lead-1' })
      )
    ]
    expect(accepted.map((entry) => entry?.payload.state)).toEqual(['done', 'working', 'working'])

    // Every child event before and after its SubagentStart: none may touch the pane.
    const childEvents = [
      child('SessionStart', { source: 'startup' }),
      subagentEdge('SubagentStart'),
      child('UserPromptSubmit', { prompt: 'audit src/' }),
      child('PreToolUse', { tool_name: 'read', tool_use_id: 'call-child-1' }),
      child('PostToolUse', { tool_name: 'read', tool_use_id: 'call-child-1' }),
      child('Stop', { stop_hook_active: false }),
      subagentEdge('SubagentStop')
    ]
    for (const payload of childEvents) {
      expect(normalizeAndAccept(state, 'dsh', payload)).toBeNull()
    }

    const leadResumed = normalizeAndAccept(
      state,
      'dsh',
      event('PostToolUse', { tool_name: 'subagent', tool_use_id: 'call-lead-1' })
    )
    expect(leadResumed?.payload.state).toBe('working')
    expect(leadResumed?.payload.prompt).toBe('delegate the audit')
    const leadDone = normalizeAndAccept(state, 'dsh', event('Stop', { stop_hook_active: false }))
    expect(leadDone?.payload.state).toBe('done')

    for (const entry of [...accepted, leadResumed, leadDone]) {
      expect(entry?.providerSession).toEqual({ key: 'session_id', id: SESSION_ID })
    }
  })

  it('drops a child prompt that beats its SubagentStart', () => {
    normalizeAndAccept(state, 'dsh', event('UserPromptSubmit', { prompt: 'delegate' }))
    // Why possible: the child's prompt is queued one await before SubagentStart is emitted.
    expect(
      normalizeAndAccept(state, 'dsh', child('SessionStart', { source: 'startup' }))
    ).toBeNull()
    expect(normalizeAndAccept(state, 'dsh', child('UserPromptSubmit', { prompt: 'x' }))).toBeNull()
    expect(normalizeAndAccept(state, 'dsh', subagentEdge('SubagentStart'))).toBeNull()

    // Long after the claim, the child is still a child.
    vi.advanceTimersByTime(60_000)
    expect(normalizeAndAccept(state, 'dsh', child('Stop'))).toBeNull()
    const lead = normalizeAndAccept(state, 'dsh', event('Stop'))
    expect(lead?.payload.prompt).toBe('delegate')
    expect(lead?.providerSession?.id).toBe(SESSION_ID)
  })

  it('switches the lead when /new or /resume starts a session at an idle composer', () => {
    normalizeAndAccept(state, 'dsh', event('UserPromptSubmit', { prompt: 'first' }))
    normalizeAndAccept(state, 'dsh', event('Stop'))

    const started = normalizeAndAccept(
      state,
      'dsh',
      event('SessionStart', { session_id: NEW_SESSION_ID, source: 'resume' })
    )
    expect(started?.payload.state).toBe('done')
    expect(started?.payload.sessionBoundary).toBe(true)
    expect(started?.providerSession?.id).toBe(NEW_SESSION_ID)

    const prompted = normalizeAndAccept(
      state,
      'dsh',
      event('UserPromptSubmit', { session_id: NEW_SESSION_ID, prompt: 'second' })
    )
    expect(prompted?.payload.prompt).toBe('second')
    expect(prompted?.providerSession?.id).toBe(NEW_SESSION_ID)
    // The old lead's late hooks no longer speak for the pane.
    expect(normalizeAndAccept(state, 'dsh', event('Stop'))).toBeNull()
  })

  it('switches the lead on the new session prompt when the old turn never posted Stop', () => {
    // An interrupted DSH turn ends without a Stop hook, so the listener still thinks the
    // lead is mid-turn when the user runs /new.
    normalizeAndAccept(state, 'dsh', event('UserPromptSubmit', { prompt: 'first' }))
    expect(
      normalizeAndAccept(state, 'dsh', event('SessionStart', { session_id: NEW_SESSION_ID }))
    ).toBeNull()

    vi.advanceTimersByTime(10_000)
    const prompted = normalizeAndAccept(
      state,
      'dsh',
      event('UserPromptSubmit', { session_id: NEW_SESSION_ID, prompt: 'second' })
    )
    expect(prompted?.payload.state).toBe('working')
    expect(prompted?.payload.prompt).toBe('second')
    expect(prompted?.providerSession?.id).toBe(NEW_SESSION_ID)
    const stopped = normalizeAndAccept(state, 'dsh', event('Stop', { session_id: NEW_SESSION_ID }))
    expect(stopped?.providerSession?.id).toBe(NEW_SESSION_ID)
  })

  it('never lets a child session start mark a working pane done', () => {
    normalizeAndAccept(state, 'dsh', event('UserPromptSubmit', { prompt: 'delegate' }))
    expect(normalizeAndAccept(state, 'dsh', child('SessionStart', { source: 'resume' }))).toBeNull()
    expect(state.lastStatusByPaneKey.values().next().value?.payload.state).toBe('working')
  })

  it('hands the pane back to the lead when a child was adopted before any lead event', () => {
    // An Orca or relay restart mid-run: the first event the fresh listener sees is the child's.
    expect(
      normalizeAndAccept(state, 'dsh', child('PostToolUse', { tool_name: 'read' }))
    ).not.toBeNull()
    expect(normalizeAndAccept(state, 'dsh', subagentEdge('SubagentStop'))).toBeNull()

    const lead = normalizeAndAccept(state, 'dsh', event('PostToolUse', { tool_name: 'subagent' }))
    expect(lead?.providerSession?.id).toBe(SESSION_ID)
    expect(normalizeAndAccept(state, 'dsh', child('Stop'))).toBeNull()
  })

  it('resumes from the restored lead when a child starts right after a listener restart', () => {
    normalizeAndAccept(state, 'dsh', event('UserPromptSubmit', { prompt: 'delegate' }))
    // A restart keeps the hydrated status row but loses the in-memory DSH pane state.
    state.dshPaneStateByPaneKey.clear()

    expect(
      normalizeAndAccept(state, 'dsh', child('SessionStart', { source: 'startup' }))
    ).toBeNull()
    expect(normalizeAndAccept(state, 'dsh', subagentEdge('SubagentStart'))).toBeNull()
    const restored = state.lastStatusByPaneKey.values().next().value
    expect(restored?.payload.state).toBe('working')
    expect(restored?.providerSession?.id).toBe(SESSION_ID)

    const lead = normalizeAndAccept(state, 'dsh', event('Stop'))
    expect(lead?.providerSession?.id).toBe(SESSION_ID)
  })
})
