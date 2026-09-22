import { describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
import { isInterruptedAgentCompletion } from './agent-interrupt-outcome'
import { normalizeAgentStatusPayload, parseAgentStatusPayload } from './agent-status-types'
import { makePaneKey } from './stable-pane-id'

const PANE = makePaneKey('tab-interrupt', '44444444-4444-4444-8444-444444444444')
const RUNNING_SHELL = {
  id: 'b8rs2wmxg',
  type: 'shell',
  status: 'running',
  description: 'Sleep for 15 seconds',
  command: 'sleep 15'
}

function claudeEvent(state: HookListenerState, payload: Record<string, unknown>) {
  return normalizeHookPayload(state, 'claude', { paneKey: PANE, payload }, 'production')?.payload
}

describe('interrupted is a turn fact, not a state claim', () => {
  it('keeps interrupted on a row that does not claim the pane finished', () => {
    for (const state of ['working', 'waiting', 'blocked'] as const) {
      expect(parseAgentStatusPayload(`{"state":"${state}","interrupted":true}`)?.interrupted).toBe(
        true
      )
      expect(normalizeAgentStatusPayload({ state, interrupted: true })?.interrupted).toBe(true)
    }
  })

  it('still rejects a non-boolean interrupted on a non-done row', () => {
    expect(
      parseAgentStatusPayload('{"state":"working","interrupted":"true"}')?.interrupted
    ).toBeUndefined()
    expect(
      parseAgentStatusPayload('{"state":"working","interrupted":1}')?.interrupted
    ).toBeUndefined()
  })

  it('reports a stopped turn without retiring the background shell it did not stop', () => {
    const state = createHookListenerState()

    expect(
      claudeEvent(state, {
        hook_event_name: 'Stop',
        is_interrupt: true,
        background_tasks: [RUNNING_SHELL]
      })
    ).toMatchObject({ state: 'working', workingMode: 'monitoring', interrupted: true })
    expect(state.claudeRunningNonAgentTaskPaneKeys.has(PANE)).toBe(true)

    // The shell drains: the same turn's all-clear is the row that may claim the pane finished.
    expect(claudeEvent(state, { hook_event_name: 'Stop', background_tasks: [] })).toMatchObject({
      state: 'done'
    })
  })

  it('reports a stopped turn without retiring a registered session cron', () => {
    const state = createHookListenerState()

    expect(
      claudeEvent(state, {
        hook_event_name: 'Stop',
        is_interrupt: true,
        session_crons: [{ id: 'cron-1' }]
      })
    ).toMatchObject({ state: 'working', workingMode: 'monitoring', interrupted: true })
    expect(state.claudeActiveSessionCronPaneKeys.has(PANE)).toBe(true)
  })

  it('carries the stop through to the turn it belongs to, then lets it go', () => {
    const state = createHookListenerState()
    claudeEvent(state, { hook_event_name: 'UserPromptSubmit', prompt: 'build it' })

    // The user stops the turn; the shell it started keeps running.
    expect(
      claudeEvent(state, {
        hook_event_name: 'Stop',
        is_interrupt: true,
        background_tasks: [RUNNING_SHELL]
      })
    ).toMatchObject({ state: 'working', workingMode: 'monitoring', interrupted: true })

    // The shell drains. This boundary is the SAME turn ending and carries no `is_interrupt` of
    // its own, so without the carry the turn would report as a clean completion — which is also
    // what the OS notification is worded from ('stopped' vs 'finished').
    expect(claudeEvent(state, { hook_event_name: 'Stop', background_tasks: [] })).toMatchObject({
      state: 'done',
      interrupted: true
    })

    // A new prompt is a new turn: the fact dies here rather than latching.
    expect(
      claudeEvent(state, { hook_event_name: 'UserPromptSubmit', prompt: 'try again' })
    ).toMatchObject({ state: 'working', interrupted: undefined })
    expect(claudeEvent(state, { hook_event_name: 'Stop', background_tasks: [] })).toMatchObject({
      state: 'done',
      interrupted: undefined
    })
  })

  it('does not carry a stop across a mid-turn lead event', () => {
    const state = createHookListenerState()
    claudeEvent(state, { hook_event_name: 'UserPromptSubmit', prompt: 'build it' })
    claudeEvent(state, { hook_event_name: 'Stop', is_interrupt: true })

    // A resumed turn can start at a tool event; that is a live turn, not the stopped one.
    expect(claudeEvent(state, { hook_event_name: 'PreToolUse' })).toMatchObject({
      state: 'working',
      interrupted: undefined
    })
    expect(
      claudeEvent(state, { hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] })
    ).toMatchObject({ state: 'working', interrupted: undefined })
  })

  it('names the interrupted-completion outcome in one predicate', () => {
    expect(isInterruptedAgentCompletion({ state: 'done', interrupted: true })).toBe(true)
    expect(isInterruptedAgentCompletion({ state: 'done' })).toBe(false)
    expect(isInterruptedAgentCompletion({ state: 'working', interrupted: true })).toBe(false)
    expect(isInterruptedAgentCompletion({ state: 'waiting', interrupted: true })).toBe(false)
  })
})
