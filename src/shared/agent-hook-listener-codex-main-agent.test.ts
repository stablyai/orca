import { beforeEach, describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import {
  reconcileRemoteCodexState,
  seedCodexStateFromSnapshot
} from './agent-hook-listener/providers/codex-state'
import { normalizeCodexEvent } from './agent-hook-listener/providers/codex-events'
import { PANE_KEY } from './agent-hook-listener-test-harness'

describe('the Codex root record seeded from a durable row', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it("takes the row's own mainAgent fact over the inferred aggregate", () => {
    seedCodexStateFromSnapshot(state, PANE_KEY, {
      state: 'waiting',
      model: 'gpt-5.4',
      subagents: [{ id: 'child', state: 'working', startedAt: 1 }],
      mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: 42 }
    })
    expect(state.codexLeadStateByPaneKey.get(PANE_KEY)).toEqual({
      state: 'done',
      outcome: 'cancellation',
      stateStartedAt: 42,
      model: 'gpt-5.4'
    })
  })

  it('still infers the root state from an older row that carries no main agent', () => {
    seedCodexStateFromSnapshot(state, PANE_KEY, {
      state: 'waiting',
      subagents: [{ id: 'child', state: 'waiting', startedAt: 1 }]
    })
    expect(state.codexLeadStateByPaneKey.get(PANE_KEY)).toMatchObject({ state: 'working' })
  })

  it('derives the main agent from a relayed root event whose row carries no mainAgent', () => {
    const reconciled = reconcileRemoteCodexState(
      state,
      PANE_KEY,
      'Stop',
      undefined,
      { state: 'done', prompt: 'ship', agentType: 'codex' },
      undefined
    )
    expect(reconciled.mainAgent).toEqual({ state: 'done', stateStartedAt: expect.any(Number) })
  })

  it('reads a relayed Interrupt with no mainAgent as a cancelled main agent', () => {
    const reconciled = reconcileRemoteCodexState(
      state,
      PANE_KEY,
      'Interrupt',
      undefined,
      { state: 'done', prompt: 'ship', agentType: 'codex' },
      undefined
    )
    expect(reconciled.mainAgent).toMatchObject({ state: 'done', outcome: 'cancellation' })
  })

  it("mirrors the relay's own main agent fact and keeps it for a child event after a relay restart", () => {
    // The relay read this cancel from Codex (its hook or its rollout); main sees only a child's event.
    const cancelled = reconcileRemoteCodexState(
      state,
      PANE_KEY,
      'PostToolUse',
      'child',
      {
        state: 'working',
        prompt: 'ship',
        agentType: 'codex',
        subagents: [{ id: 'child', state: 'working', startedAt: 1 }],
        mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: 5 }
      },
      undefined
    )
    expect(cancelled).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
    // A restarted relay publishes no mainAgent for a child event; main's copy fills it.
    const afterRestart = reconcileRemoteCodexState(
      state,
      PANE_KEY,
      'PreToolUse',
      'child',
      {
        state: 'working',
        prompt: '',
        agentType: 'codex',
        subagents: [{ id: 'child', state: 'working', startedAt: 1 }]
      },
      undefined
    )
    expect(afterRestart.mainAgent).toMatchObject({ state: 'done', outcome: 'cancellation' })
  })

  it('folds a relayed waiting child through the shared rule, inventing no root fact', () => {
    // The relay's aggregate says `working`; main re-derives the row from the roster instead, and a
    // child's event is no evidence about the main agent.
    const reconciled = reconcileRemoteCodexState(
      state,
      PANE_KEY,
      'PermissionRequest',
      'child',
      {
        state: 'working',
        prompt: 'ship',
        agentType: 'codex',
        subagents: [{ id: 'child', state: 'waiting', startedAt: 1 }]
      },
      undefined
    )
    expect(reconciled).toMatchObject({ state: 'waiting' })
    expect(reconciled.mainAgent).toBeUndefined()
  })
})

// A pane whose main-agent record is gone (its records were cleared, or a relay restarted) can still
// get its children's hooks. Nothing would ever end a main agent assumed to be working.
describe('a Codex child event with no record of the main agent', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it('lets the children alone drive the row on the execution host', () => {
    const started = normalizeCodexEvent(state, 'SubagentStart', '', PANE_KEY, {
      hook_event_name: 'SubagentStart',
      agent_id: 'child'
    })
    expect(started).toMatchObject({ state: 'working' })
    expect(started?.mainAgent).toBeUndefined()
    const stopped = normalizeCodexEvent(state, 'SubagentStop', '', PANE_KEY, {
      hook_event_name: 'SubagentStop',
      agent_id: 'child'
    })
    expect(stopped).toMatchObject({ state: 'done' })
    expect(stopped?.mainAgent).toBeUndefined()
  })

  it("lets the children alone drive main's copy of a relayed row", () => {
    const working = reconcileRemoteCodexState(
      state,
      PANE_KEY,
      'SubagentStart',
      'child',
      {
        state: 'working',
        prompt: '',
        agentType: 'codex',
        subagents: [{ id: 'child', state: 'working', startedAt: 1 }]
      },
      undefined
    )
    expect(working).toMatchObject({ state: 'working' })
    expect(working.mainAgent).toBeUndefined()
    const stopped = reconcileRemoteCodexState(
      state,
      PANE_KEY,
      'SubagentStop',
      'child',
      { state: 'done', prompt: '', agentType: 'codex' },
      working
    )
    expect(stopped).toMatchObject({ state: 'done' })
    expect(stopped.mainAgent).toBeUndefined()
  })
})
