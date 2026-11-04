import { beforeEach, describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import {
  markCodexLeadTurnInterrupted,
  reconcileRemoteCodexState,
  seedCodexStateFromSnapshot
} from '../providers/codex-state'
import { PANE_KEY } from './agent-hook-listener-test-harness'

describe('the Codex root record seeded from a durable row', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it("republishes a relayed row with the mainAgent fact main holds, not the relay's", () => {
    seedCodexStateFromSnapshot(state, PANE_KEY, {
      state: 'done',
      mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: 42 }
    })
    const reconciled = reconcileRemoteCodexState(
      state,
      PANE_KEY,
      'Stop',
      undefined,
      {
        state: 'done',
        prompt: 'ship',
        agentType: 'codex',
        mainAgent: { state: 'working', stateStartedAt: 99 }
      },
      undefined
    )
    expect(reconciled.mainAgent).toEqual({
      state: 'done',
      outcome: 'cancellation',
      stateStartedAt: 42
    })
  })

  it('carries the cancellation Orca inferred into a late relayed Stop', () => {
    markCodexLeadTurnInterrupted(state, PANE_KEY)
    const reconciled = reconcileRemoteCodexState(
      state,
      PANE_KEY,
      'Stop',
      undefined,
      { state: 'done', prompt: 'ship', agentType: 'codex' },
      undefined
    )
    expect(reconciled.mainAgent).toMatchObject({ state: 'done', outcome: 'cancellation' })
  })

  it('folds a relayed waiting child through the shared rule, keeping the root fact', () => {
    // The relay's aggregate says `working`; main re-derives the row from the roster instead.
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
    expect(reconciled).toMatchObject({ state: 'waiting', mainAgent: { state: 'working' } })
  })
})
