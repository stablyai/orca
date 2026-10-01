import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import {
  markCodexLeadTurnInterrupted,
  reconcileRemoteCodexState,
  seedCodexStateFromSnapshot
} from './agent-hook-listener/providers/codex-state'
import { shouldPollHookTranscript } from './agent-hook-listener/transcript-poll-policy'
import { normalizeAndAccept, PANE_KEY } from './agent-hook-listener-test-harness'

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

  it("republishes a relayed row with the mainAgent fact main holds, not the relay's", () => {
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

  it('keeps the failure a relay read from the rollout on its Stop', () => {
    reconcileRemoteCodexState(
      state,
      PANE_KEY,
      'PostToolUse',
      undefined,
      { state: 'working', prompt: 'ship', agentType: 'codex' },
      undefined
    )
    const reconciled = reconcileRemoteCodexState(
      state,
      PANE_KEY,
      'Stop',
      undefined,
      {
        state: 'done',
        prompt: 'ship',
        agentType: 'codex',
        mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 7 }
      },
      undefined
    )
    expect(reconciled).toMatchObject({
      state: 'done',
      mainAgent: { state: 'done', outcome: 'failure' }
    })
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

describe('the Codex rollout poll for an open root turn', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-turn-poll-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function pollsAfter(hook: Record<string, unknown>): boolean {
    const rollout = join(dir, 'rollout.jsonl')
    writeFileSync(rollout, '')
    const state = createHookListenerState()
    const event = normalizeAndAccept(state, 'codex', {
      hook_event_name: 'PostToolUse',
      session_id: 'root-session',
      transcript_path: rollout,
      tool_name: 'Bash',
      ...hook
    })
    if (!event) {
      throw new Error('expected a Codex status event')
    }
    return shouldPollHookTranscript(state, 'codex', event)
  }

  it('runs while the turn is open and its id can match a rollout end', () => {
    expect(pollsAfter({ turn_id: 'turn-1' })).toBe(true)
  })

  // Hooks from a Codex that sends no turn_id can never match a rollout end.
  it('does not run when the hooks carry no turn id', () => {
    expect(pollsAfter({})).toBe(false)
  })
})
