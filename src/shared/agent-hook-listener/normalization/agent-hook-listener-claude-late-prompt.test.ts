import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from './normalize-hook-payload'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import type { AgentHookEventPayload } from '../listener-event'
import { reduceHostTurnEnd } from '../state/agent-hook-turn-end-timing'
import { makePaneKey } from '../../workspace-layout/stable-pane-id'
import { seedLegacyAgentStatusForTests } from '../legacy-agent-status-test-seed'
import { ClaudeOwedNotificationExpiryTimers } from '../providers/claude/background-tasks/claude-owed-notification-expiry-timers'

const PANE_KEY = makePaneKey('claude-late-prompt', '22222222-2222-4222-8222-222222222222')
const FIRST = '0b6f1a52-2f43-4f0e-9d55-0c9f6a1e2b31'
const SECOND = '7c2e9d14-81a0-4b6b-a3c5-5e0d2f9b4a77'
const THIRD = 'c41d7e0a-5b9f-4c26-8e13-2a6f0d9b7c58'
const SHELL = {
  id: 'b8rs2wmxg',
  type: 'shell',
  status: 'running',
  description: 'Sleep for 15 seconds',
  command: 'sleep 15'
}

// Claude runs Orca's prompt hook without waiting, so its event can arrive after later events of its turn.
describe('Claude prompt event arriving after its turn', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  function event(payload: Record<string, unknown>, isReplay = false) {
    return normalizeHookPayload(
      state,
      'claude',
      { paneKey: PANE_KEY, payload: { session_id: 'session-a', ...payload } },
      'production',
      { isReplay }
    )
  }

  function claude(payload: Record<string, unknown>) {
    return event(payload)?.payload
  }

  it('keeps a finished turn done, with its prompt label, when the prompt event lands after Stop', () => {
    expect(claude({ hook_event_name: 'Stop', prompt_id: FIRST })?.state).toBe('done')

    const late = claude({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'hi' })
    expect(late).toMatchObject({ state: 'done', prompt: 'hi' })

    expect(
      claude({ hook_event_name: 'UserPromptSubmit', prompt_id: SECOND, prompt: 'next' })
    ).toMatchObject({ state: 'working', prompt: 'next' })

    // An older turn's prompt arriving late must not relabel the running turn.
    claude({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'old' })
    expect(
      claude({
        hook_event_name: 'PreToolUse',
        prompt_id: SECOND,
        tool_name: 'Bash',
        tool_use_id: 't1'
      })
    ).toMatchObject({ state: 'working', prompt: 'next' })
  })

  it('runs a fast prompt then Stop in order as working then done', () => {
    expect(
      claude({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'hi' })?.state
    ).toBe('working')
    expect(claude({ hook_event_name: 'Stop', prompt_id: FIRST })?.state).toBe('done')
  })

  // Recorded from Claude 2.1.325: a prompt typed mid-turn joins the running turn under its prompt_id,
  // and a background-task wakeup opens a turn under a new one.
  it('keeps a mid-turn prompt in its turn and opens a wakeup turn', () => {
    claude({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'start the task' })
    claude({
      hook_event_name: 'PreToolUse',
      prompt_id: FIRST,
      tool_name: 'Bash',
      tool_use_id: 't1'
    })
    expect(
      claude({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'also this' })
    ).toMatchObject({ state: 'working', prompt: 'also this' })
    expect(claude({ hook_event_name: 'Stop', prompt_id: FIRST })?.state).toBe('done')

    expect(
      claude({
        hook_event_name: 'UserPromptSubmit',
        prompt_id: SECOND,
        prompt: '<task-notification>\n<task-id>bg-1</task-id>\n</task-notification>'
      })?.state
    ).toBe('working')
  })

  it('ends a turn whose prompt event is still in flight as its own turn', () => {
    let row: AgentHookEventPayload | undefined
    let at = 1_000
    const fold = (payload: Record<string, unknown>) => {
      const next = event(payload)
      if (!next) {
        throw new Error('event rejected')
      }
      row = { ...next, ...reduceHostTurnEnd(row, next, (at += 10), true) }
      return row
    }
    fold({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'first' })
    fold({ hook_event_name: 'Stop', prompt_id: FIRST })
    expect(
      fold({
        hook_event_name: 'PreToolUse',
        prompt_id: SECOND,
        tool_name: 'Bash',
        tool_use_id: 't'
      })
    ).toMatchObject({ opensTurn: true, payload: { state: 'working', prompt: '' } })
    expect(fold({ hook_event_name: 'Stop', prompt_id: SECOND })).toMatchObject({
      turnEndDisposition: 'identified',
      payload: { state: 'done' }
    })
    expect(
      fold({ hook_event_name: 'UserPromptSubmit', prompt_id: SECOND, prompt: 'second' })
    ).toMatchObject({ hookEventName: 'UserPromptSubmit:late', payload: { prompt: 'second' } })
  })

  it('retires an interrupted turn’s calls before the next turn asks for permission', () => {
    const ls = { tool_name: 'Bash', tool_input: { command: 'ls' } }
    claude({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'list it' })
    claude({ hook_event_name: 'PreToolUse', prompt_id: FIRST, tool_use_id: 'old', ...ls })
    // Interrupted with no hook; the next prompt's event is still in flight when its tool asks again.
    claude({ hook_event_name: 'PreToolUse', prompt_id: SECOND, tool_use_id: 'new', ...ls })

    expect(event({ hook_event_name: 'PermissionRequest', prompt_id: SECOND, ...ls })).toMatchObject(
      { toolUseId: 'new', payload: { state: 'waiting' } }
    )
  })

  it('never opens a lead turn for a plugin’s tool call or its permission request', () => {
    const ls = { tool_name: 'Bash', tool_input: { command: 'ls' } }
    claude({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'hi' })
    claude({ hook_event_name: 'Stop', prompt_id: FIRST })

    expect(
      event({
        hook_event_name: 'PreToolUse',
        prompt_id: SECOND,
        tool_use_id: 'toolu_plugin_1',
        ...ls
      })?.opensTurn
    ).toBeUndefined()
    expect(
      event({ hook_event_name: 'PermissionRequest', prompt_id: SECOND, ...ls })?.opensTurn
    ).toBeUndefined()
  })

  it('drops a prompt event from a conversation the pane already cleared', () => {
    claude({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'first' })
    claude({ hook_event_name: 'Stop', prompt_id: FIRST })
    claude({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'session-b' })

    expect(
      event({
        hook_event_name: 'UserPromptSubmit',
        prompt_id: SECOND,
        prompt: 'typed before /clear'
      })
    ).toBeNull()
    expect(
      claude({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'session-b',
        prompt_id: THIRD,
        prompt: 'fresh'
      })
    ).toMatchObject({ state: 'working', prompt: 'fresh' })
  })

  it('never lets a replayed event make an old turn current', () => {
    claude({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'first' })
    claude({ hook_event_name: 'Stop', prompt_id: FIRST })
    claude({
      hook_event_name: 'PreToolUse',
      prompt_id: SECOND,
      tool_name: 'Bash',
      tool_use_id: 't'
    })
    event(
      { hook_event_name: 'PreToolUse', prompt_id: FIRST, tool_name: 'Bash', tool_use_id: 'r' },
      true
    )

    expect(
      claude({ hook_event_name: 'UserPromptSubmit', prompt_id: SECOND, prompt: 'second' })
    ).toMatchObject({ prompt: 'second' })
  })

  it('keeps a replayed finished turn done when its prompt event replays after it', () => {
    event({ hook_event_name: 'Stop', prompt_id: FIRST }, true)
    event({ hook_event_name: 'Stop', session_id: 'session-b', prompt_id: SECOND }, true)

    expect(
      event(
        {
          hook_event_name: 'UserPromptSubmit',
          session_id: 'session-b',
          prompt_id: SECOND,
          prompt: 'hi'
        },
        true
      )?.payload
    ).toMatchObject({ state: 'done', prompt: 'hi' })
  })

  it('keeps a turn replayed after a live event done when its prompt event replays', () => {
    claude({ hook_event_name: 'SessionStart', source: 'startup' })
    event({ hook_event_name: 'Stop', prompt_id: FIRST }, true)

    expect(
      event({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'hi' }, true)?.payload
        ?.state
    ).not.toBe('working')
  })

  it('never shows the pane working for an older turn’s prompt replayed after live events', () => {
    claude({ hook_event_name: 'SessionStart', source: 'startup' })
    claude({ hook_event_name: 'UserPromptSubmit', prompt_id: SECOND, prompt: 'now' })
    claude({ hook_event_name: 'Stop', prompt_id: SECOND })

    expect(
      event({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'old' }, true)?.payload
        ?.state
    ).not.toBe('working')
    expect(
      event(
        {
          hook_event_name: 'UserPromptSubmit',
          session_id: 'session-z',
          prompt_id: THIRD,
          prompt: 'old'
        },
        true
      )?.payload?.state
    ).not.toBe('working')
  })

  describe('a finished background task’s wakeup after the person’s turn was announced', () => {
    const done = `<task-notification>\n<task-id>${SHELL.id}</task-id>\n<status>completed</status>`

    function personTurnHeldByShell(): number | undefined {
      claude({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'watch' })
      claude({
        hook_event_name: 'PostToolUse',
        prompt_id: FIRST,
        tool_name: 'Bash',
        tool_input: { command: SHELL.command, run_in_background: true },
        tool_response: { backgroundTaskId: SHELL.id }
      })
      return claude({ hook_event_name: 'Stop', prompt_id: FIRST, background_tasks: [SHELL] })
        ?.turnCompletedAt
    }

    it('repeats the person’s end when the wakeup’s tool call beats its prompt event', () => {
      const personEnd = personTurnHeldByShell()
      expect(typeof personEnd).toBe('number')
      claude({
        hook_event_name: 'PreToolUse',
        prompt_id: SECOND,
        tool_name: 'Bash',
        tool_use_id: 'w'
      })

      expect(
        claude({ hook_event_name: 'UserPromptSubmit', prompt_id: SECOND, prompt: done })
          ?.turnCompletedAt
      ).toBe(personEnd)
      expect(
        claude({ hook_event_name: 'Stop', prompt_id: SECOND, background_tasks: [] })
      ).toMatchObject({ state: 'done', turnCompletedAt: personEnd })
    })

    it('repeats the person’s end when the wakeup’s Stop beats its prompt event', () => {
      const personEnd = personTurnHeldByShell()
      claude({ hook_event_name: 'Stop', prompt_id: SECOND, background_tasks: [] })

      expect(
        claude({ hook_event_name: 'UserPromptSubmit', prompt_id: SECOND, prompt: done })
      ).toMatchObject({ state: 'done', turnCompletedAt: personEnd })
    })

    it('never gives the person’s next turn the end it already announced', () => {
      const personEnd = personTurnHeldByShell()
      claude({ hook_event_name: 'UserPromptSubmit', prompt_id: SECOND, prompt: done })
      // The wakeup is interrupted without a hook; the person's next turn ends before its prompt event lands.
      expect(
        claude({ hook_event_name: 'Stop', prompt_id: THIRD, background_tasks: [] })?.turnCompletedAt
      ).not.toBe(personEnd)
    })
  })

  describe('a turn whose Stop beats its prompt event while a shell runs', () => {
    function startWatching() {
      claude({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'watch' })
      claude({
        hook_event_name: 'PostToolUse',
        prompt_id: FIRST,
        tool_name: 'Bash',
        tool_input: { command: SHELL.command, run_in_background: true },
        tool_response: { backgroundTaskId: SHELL.id }
      })
      const first = claude({ hook_event_name: 'Stop', prompt_id: FIRST, background_tasks: [SHELL] })
      expect(typeof first?.turnCompletedAt).toBe('number')
      const wakeEnd = claude({
        hook_event_name: 'Stop',
        prompt_id: SECOND,
        background_tasks: [SHELL]
      })
      expect(wakeEnd).toMatchObject({ state: 'working', workingMode: 'monitoring' })
      expect(wakeEnd?.turnCompletedAt).toBeUndefined()
    }

    it('never announces the wakeup as a finished turn', () => {
      startWatching()
      const late = claude({
        hook_event_name: 'UserPromptSubmit',
        prompt_id: SECOND,
        prompt: `<task-notification>\n<task-id>${SHELL.id}</task-id>\n<event>tick</event>`
      })
      expect(late?.turnCompletedAt).toBeUndefined()
    })

    it('announces a person’s turn once its prompt event arrives', () => {
      startWatching()
      const late = claude({ hook_event_name: 'UserPromptSubmit', prompt_id: SECOND, prompt: 'hi' })
      expect(typeof late?.turnCompletedAt).toBe('number')
    })

    it('announces it as a person’s turn when its prompt event never arrives', () => {
      vi.useFakeTimers()
      try {
        startWatching()
        seedLegacyAgentStatusForTests(state, {
          paneKey: PANE_KEY,
          connectionId: null,
          payload: { state: 'working', prompt: '', agentType: 'claude' }
        })
        const published: AgentHookEventPayload[] = []
        new ClaudeOwedNotificationExpiryTimers(state).arm(PANE_KEY, (row) => published.push(row))

        vi.advanceTimersByTime(4_000)
        expect(published).toEqual([])
        vi.advanceTimersByTime(1_000)
        expect(typeof published.at(-1)?.payload.turnCompletedAt).toBe('number')
      } finally {
        vi.useRealTimers()
      }
    })

    it('still expires an owed notification after the held end is released on a host that stores no row', () => {
      vi.useFakeTimers()
      try {
        claude({ hook_event_name: 'UserPromptSubmit', prompt_id: FIRST, prompt: 'watch' })
        for (const id of [SHELL.id, 'ended-shell']) {
          claude({
            hook_event_name: 'PostToolUse',
            prompt_id: FIRST,
            tool_name: 'Bash',
            tool_input: { command: 'sleep 1', run_in_background: true },
            tool_response: { backgroundTaskId: id }
          })
        }
        claude({ hook_event_name: 'Stop', prompt_id: FIRST, background_tasks: [SHELL] })
        claude({ hook_event_name: 'Stop', prompt_id: SECOND, background_tasks: [SHELL] })
        seedLegacyAgentStatusForTests(state, {
          paneKey: PANE_KEY,
          connectionId: null,
          payload: { state: 'working', prompt: '', agentType: 'claude' }
        })
        const published: AgentHookEventPayload[] = []
        new ClaudeOwedNotificationExpiryTimers(state).arm(PANE_KEY, (row) => published.push(row))

        vi.advanceTimersByTime(5_000)
        expect(published).toHaveLength(1)
        vi.advanceTimersByTime(60_000)
        expect(published).toHaveLength(2)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
