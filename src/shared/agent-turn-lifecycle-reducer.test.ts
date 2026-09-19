import { describe, expect, it } from 'vitest'
import type { AgentTurnLifecycleEvent, AgentTurnOwner } from './agent-turn-lifecycle-contract'
import {
  createAgentTurnLifecycleState,
  isAgentTurnLifecycleEvent,
  reduceAgentTurnLifecycle,
  readAgentTurnLifecycleSnapshot
} from './agent-turn-lifecycle'

const owner: AgentTurnOwner = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-c1',
  workspaceKind: 'folder',
  runId: 'run-c1',
  attachment: { executionId: 'execution-c1' },
  provider: 'claude'
}

let eventNumber = 0
type EventInput = AgentTurnLifecycleEvent extends infer Candidate
  ? Candidate extends AgentTurnLifecycleEvent
    ? Omit<Candidate, 'owner' | 'evidence'>
    : never
  : never

function event(input: EventInput): AgentTurnLifecycleEvent {
  eventNumber += 1
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: EventInput is a discriminated union with owner/evidence intentionally omitted; this constructor restores both fields.
  return {
    ...input,
    owner,
    evidence: {
      eventId: `event-${eventNumber}`,
      producerId: 'c1-test',
      observedAt: eventNumber
    }
  } as AgentTurnLifecycleEvent
}

function state() {
  eventNumber = 0
  return createAgentTurnLifecycleState(owner)
}

function apply(current: ReturnType<typeof state>, nextEvent: AgentTurnLifecycleEvent) {
  return reduceAgentTurnLifecycle(current, nextEvent)
}

describe('canonical agent turn lifecycle reducer', () => {
  it('folds child-before-parent completion without letting a child settle the root', () => {
    let current = state()
    current = apply(
      current,
      event({
        kind: 'work-outcome-observed',
        turnId: 'turn-1',
        workId: 'child-1',
        workKind: 'joined-child',
        outcome: 'completed'
      })
    ).state
    current = apply(current, event({ kind: 'turn-started', turnId: 'turn-1' })).state
    expect(current.work[0]).toMatchObject({ turnId: 'turn-1', workId: 'child-1', phase: 'settled' })
    expect(current.turns[0]).toMatchObject({ turnId: 'turn-1', phase: 'active', outcome: null })
  })

  it('keeps a newer current turn when a late completion arrives for the prior turn', () => {
    let current = state()
    current = apply(current, event({ kind: 'turn-started', turnId: 'turn-1' })).state
    current = apply(current, event({ kind: 'turn-started', turnId: 'turn-2' })).state
    const late = apply(
      current,
      event({
        kind: 'turn-outcome-observed',
        turnId: 'turn-1',
        outcome: 'completed',
        recordKind: 'event'
      })
    )
    expect(late.state.currentTurnId).toBe('turn-2')
    expect(late.state.turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ turnId: 'turn-1', phase: 'settled', outcome: 'completed' }),
        expect.objectContaining({ turnId: 'turn-2', phase: 'active' })
      ])
    )
  })

  it('preserves resident background work when a newer root supersedes its turn', () => {
    let current = state()
    current = apply(current, event({ kind: 'turn-started', turnId: 'turn-1' })).state
    current = apply(
      current,
      event({
        kind: 'work-started',
        turnId: 'turn-1',
        workId: 'child-1',
        workKind: 'joined-child'
      })
    ).state
    current = apply(
      current,
      event({
        kind: 'work-started',
        turnId: 'turn-1',
        workId: 'monitor-1',
        workKind: 'resident-background'
      })
    ).state

    const superseded = apply(current, event({ kind: 'turn-started', turnId: 'turn-2' }))

    expect(superseded.state.turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ turnId: 'turn-1', phase: 'unresolved' }),
        expect.objectContaining({ turnId: 'turn-2', phase: 'active' })
      ])
    )
    expect(superseded.state.work).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workId: 'child-1',
          kind: 'joined-child',
          phase: 'unresolved'
        }),
        expect.objectContaining({
          workId: 'monitor-1',
          kind: 'resident-background',
          phase: 'active'
        })
      ])
    )

    const exited = apply(
      superseded.state,
      event({ kind: 'execution-verdict-observed', verdict: 'exited' })
    )
    expect(exited.state.work).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workId: 'monitor-1',
          kind: 'resident-background',
          phase: 'unresolved'
        })
      ])
    )
  })

  it('does not gate root dispatch settlement on resident background work', () => {
    let current = state()
    current = apply(current, event({ kind: 'turn-started', turnId: 'turn-1' })).state
    current = apply(
      current,
      event({
        kind: 'work-started',
        turnId: 'turn-1',
        workId: 'monitor-1',
        workKind: 'resident-background'
      })
    ).state
    current = apply(
      current,
      event({
        kind: 'current-turn-inventory',
        complete: true,
        currentTurn: {
          turnId: 'turn-1',
          joinedChildren: [],
          residentBackground: [{ workId: 'monitor-1', phase: 'active' }]
        }
      })
    ).state
    current = apply(
      current,
      event({ kind: 'dispatch-associated', dispatchId: 'dispatch-1', turnId: 'turn-1' })
    ).state
    current = apply(
      current,
      event({ kind: 'dispatch-received', dispatchId: 'dispatch-1', turnId: 'turn-1' })
    ).state
    const settled = apply(
      current,
      event({
        kind: 'turn-outcome-observed',
        turnId: 'turn-1',
        outcome: 'completed',
        recordKind: 'event'
      })
    )
    expect(settled.committedDispatches).toEqual([
      expect.objectContaining({ dispatchId: 'dispatch-1', outcome: 'completed' })
    ])
    expect(settled.state.work).toEqual([
      expect.objectContaining({ kind: 'resident-background', phase: 'active' })
    ])
  })

  it('allows an attributable terminal record to recover a missed start, but not an ordinary end', () => {
    const ordinary = apply(
      state(),
      event({
        kind: 'turn-outcome-observed',
        turnId: 'turn-missed',
        outcome: 'completed',
        recordKind: 'event'
      })
    )
    expect(ordinary.disposition).toBe('ignored')
    expect(ordinary.reason).toBe('stale')
    const recovered = apply(
      state(),
      event({
        kind: 'turn-outcome-observed',
        turnId: 'turn-missed',
        outcome: 'completed',
        recordKind: 'terminal-record'
      })
    )
    expect(recovered.committedOutcomes).toEqual([
      expect.objectContaining({ turnId: 'turn-missed', outcome: 'completed' })
    ])
    expect(recovered.state.turns[0]).toMatchObject({ startedAt: null, phase: 'settled' })
  })

  it('requires dispatch receipt before settling a dispatch', () => {
    let current = state()
    current = apply(current, event({ kind: 'turn-started', turnId: 'turn-1' })).state
    current = apply(
      current,
      event({
        kind: 'current-turn-inventory',
        complete: true,
        currentTurn: { turnId: 'turn-1', joinedChildren: [], residentBackground: [] }
      })
    ).state
    current = apply(
      current,
      event({ kind: 'dispatch-associated', dispatchId: 'dispatch-1', turnId: 'turn-1' })
    ).state
    current = apply(
      current,
      event({
        kind: 'turn-outcome-observed',
        turnId: 'turn-1',
        outcome: 'completed',
        recordKind: 'event'
      })
    ).state
    expect(current.dispatches[0].outcome).toBeNull()
    const received = apply(
      current,
      event({ kind: 'dispatch-received', dispatchId: 'dispatch-1', turnId: 'turn-1' })
    )
    expect(received.committedDispatches).toEqual([
      expect.objectContaining({ dispatchId: 'dispatch-1', outcome: 'completed' })
    ])
  })

  it('settles completion as unresolved until authoritative inventory closes finite children', () => {
    let current = state()
    current = apply(current, event({ kind: 'turn-started', turnId: 'turn-unknown' })).state
    current = apply(
      current,
      event({ kind: 'dispatch-received', dispatchId: 'dispatch-unknown', turnId: 'turn-unknown' })
    ).state
    const settled = apply(
      current,
      event({
        kind: 'turn-outcome-observed',
        turnId: 'turn-unknown',
        outcome: 'completed',
        recordKind: 'event'
      })
    )
    expect(settled.committedDispatches).toEqual([
      expect.objectContaining({ dispatchId: 'dispatch-unknown', outcome: 'unresolved' })
    ])
  })

  it('does not trust a complete inventory after a late joined-child start', () => {
    let current = state()
    current = apply(current, event({ kind: 'turn-started', turnId: 'turn-late-child' })).state
    current = apply(
      current,
      event({
        kind: 'current-turn-inventory',
        complete: true,
        currentTurn: { turnId: 'turn-late-child', joinedChildren: [], residentBackground: [] }
      })
    ).state
    current = apply(
      current,
      event({
        kind: 'turn-outcome-observed',
        turnId: 'turn-late-child',
        outcome: 'completed',
        recordKind: 'event'
      })
    ).state
    current = apply(
      current,
      event({
        kind: 'work-started',
        turnId: 'turn-late-child',
        workId: 'child-late',
        workKind: 'joined-child'
      })
    ).state

    const received = apply(
      current,
      event({
        kind: 'dispatch-received',
        dispatchId: 'dispatch-late-child',
        turnId: 'turn-late-child'
      })
    )
    expect(received.committedDispatches).toEqual([
      expect.objectContaining({ dispatchId: 'dispatch-late-child', outcome: 'unresolved' })
    ])
  })

  it('folds a failed joined child into dispatch settlement after complete inventory', () => {
    let current = state()
    current = apply(current, event({ kind: 'turn-started', turnId: 'turn-child-failure' })).state
    current = apply(
      current,
      event({
        kind: 'current-turn-inventory',
        complete: true,
        currentTurn: {
          turnId: 'turn-child-failure',
          joinedChildren: [{ workId: 'child-failure', phase: 'settled', outcome: 'failed' }],
          residentBackground: []
        }
      })
    ).state
    current = apply(
      current,
      event({
        kind: 'dispatch-received',
        dispatchId: 'dispatch-child-failure',
        turnId: 'turn-child-failure'
      })
    ).state
    const settled = apply(
      current,
      event({
        kind: 'turn-outcome-observed',
        turnId: 'turn-child-failure',
        outcome: 'completed',
        recordKind: 'event'
      })
    )
    expect(settled.committedDispatches).toEqual([
      expect.objectContaining({ dispatchId: 'dispatch-child-failure', outcome: 'failed' })
    ])
  })

  it('abandons a dispatch without rewriting its observed receipt', () => {
    let current = state()
    current = apply(current, event({ kind: 'turn-started', turnId: 'turn-abandon' })).state
    current = apply(
      current,
      event({ kind: 'dispatch-received', dispatchId: 'dispatch-abandon', turnId: 'turn-abandon' })
    ).state
    const abandoned = apply(
      current,
      event({ kind: 'dispatch-abandoned', dispatchId: 'dispatch-abandon', turnId: 'turn-abandon' })
    )
    expect(abandoned.disposition).toBe('accepted')
    expect(abandoned.state.dispatches[0]).toMatchObject({
      receipt: 'received',
      outcome: 'abandoned'
    })
  })

  it('keeps interrupt request separate from acknowledgement', () => {
    let current = state()
    current = apply(current, event({ kind: 'turn-started', turnId: 'turn-1' })).state
    current = apply(
      current,
      event({
        kind: 'work-started',
        turnId: 'turn-1',
        workId: 'monitor-1',
        workKind: 'resident-background'
      })
    ).state
    current = apply(current, event({ kind: 'turn-interrupt-requested', turnId: 'turn-1' })).state
    expect(current.turns[0]).toMatchObject({
      phase: 'active',
      outcome: null,
      interrupt: 'requested'
    })
    current = apply(
      current,
      event({ kind: 'turn-interrupt-input-written', turnId: 'turn-1' })
    ).state
    expect(current.turns[0]).toMatchObject({
      phase: 'active',
      outcome: null,
      interruptInputWrittenAt: 4
    })
    const acknowledged = apply(
      current,
      event({ kind: 'turn-interrupt-acknowledged', turnId: 'turn-1' })
    )
    expect(acknowledged.committedOutcomes).toEqual([
      expect.objectContaining({ turnId: 'turn-1', outcome: 'interrupted' })
    ])
    expect(acknowledged.state.turns[0]).toMatchObject({
      phase: 'settled',
      interrupt: 'acknowledged'
    })
    expect(acknowledged.state.work[0]).toMatchObject({
      kind: 'resident-background',
      phase: 'active'
    })
  })

  it('marks active turns unresolved when execution exits without declaring success', () => {
    let current = state()
    current = apply(current, event({ kind: 'turn-started', turnId: 'turn-1' })).state
    current = apply(
      current,
      event({
        kind: 'work-started',
        turnId: 'turn-1',
        workId: 'monitor-1',
        workKind: 'resident-background'
      })
    ).state
    const exited = apply(current, event({ kind: 'execution-verdict-observed', verdict: 'exited' }))
    expect(exited.committedOutcomes).toEqual([])
    expect(exited.state.executionVerdict).toBe('exited')
    expect(exited.state.turns[0]).toMatchObject({ phase: 'unresolved', outcome: null })
    expect(exited.state.work[0]).toMatchObject({
      kind: 'resident-background',
      phase: 'unresolved',
      outcome: null
    })
  })

  it('reconciles a complete current-turn inventory and preserves uncertainty', () => {
    let current = state()
    current = apply(current, event({ kind: 'turn-started', turnId: 'turn-1' })).state
    current = apply(
      current,
      event({
        kind: 'work-started',
        turnId: 'turn-1',
        workId: 'child-1',
        workKind: 'joined-child'
      })
    ).state
    const inventory = apply(
      current,
      event({
        kind: 'current-turn-inventory',
        complete: true,
        currentTurn: {
          turnId: 'turn-1',
          joinedChildren: [],
          residentBackground: [{ workId: 'monitor-1', phase: 'settled' }]
        }
      })
    )
    expect(inventory.state.work).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workId: 'child-1', phase: 'unresolved', outcome: null }),
        expect.objectContaining({ workId: 'monitor-1', phase: 'unresolved', outcome: null })
      ])
    )
    expect(readAgentTurnLifecycleSnapshot(inventory.state).currentTurn?.turnId).toBe('turn-1')
  })

  it('expires a lapsed recovery custody without an explicit expiry event', () => {
    let current = state()
    current = apply(current, event({ kind: 'turn-started', turnId: 'turn-ttl' })).state
    current = apply(
      current,
      event({ kind: 'dispatch-received', dispatchId: 'dispatch-ttl', turnId: 'turn-ttl' })
    ).state
    current = apply(
      current,
      event({
        kind: 'turn-recovery-started',
        turnId: 'turn-ttl',
        custodyId: 'custody-ttl',
        deadlineAt: 25
      })
    ).state
    expect(current.recoveries).toHaveLength(1)
    expect(current.turns[0]).toMatchObject({ phase: 'recovering' })
    // Any later evidence re-derives the lapsed deadline; the producer that opened
    // the custody never sends its expiry event.
    const unrelated = event({ kind: 'turn-started', turnId: 'turn-ttl-next' })
    const swept = apply(current, {
      ...unrelated,
      evidence: { ...unrelated.evidence, observedAt: 30 }
    })
    expect(swept.state.recoveries).toHaveLength(0)
    expect(swept.state.turns.find((turn) => turn.turnId === 'turn-ttl')).toMatchObject({
      phase: 'unresolved'
    })
    expect(swept.state.dispatches[0]).toMatchObject({ outcome: 'unresolved' })
  })

  it('latches an integrity breach on the turn rather than the bounded issue ring', () => {
    let current = state()
    current = apply(current, event({ kind: 'turn-started', turnId: 'turn-breach' })).state
    current = apply(
      current,
      event({
        kind: 'turn-outcome-observed',
        turnId: 'turn-breach',
        outcome: 'completed',
        recordKind: 'event'
      })
    ).state
    const conflicted = apply(
      current,
      event({
        kind: 'turn-outcome-observed',
        turnId: 'turn-breach',
        outcome: 'failed',
        recordKind: 'event'
      })
    )
    expect(conflicted.state.turns[0]).toMatchObject({
      turnId: 'turn-breach',
      integrityBreached: true
    })
  })

  it('bounds recovery custody and supports expiry versus explicit abandon', () => {
    let current = state()
    current = apply(
      current,
      event({
        kind: 'turn-recovery-started',
        turnId: 'turn-1',
        custodyId: 'custody-1',
        deadlineAt: 20
      })
    ).state
    const early = apply(
      current,
      event({ kind: 'turn-recovery-expired', turnId: 'turn-1', custodyId: 'custody-1' })
    )
    expect(early.disposition).toBe('ignored')
    expect(early.reason).toBe('stale')
    const expiryEvent = event({
      kind: 'turn-recovery-expired',
      turnId: 'turn-1',
      custodyId: 'custody-1'
    })
    const expired = apply(early.state, {
      ...expiryEvent,
      evidence: { ...expiryEvent.evidence, observedAt: 20 }
    })
    expect(expired.state.recoveries).toHaveLength(0)
    expect(expired.state.turns[0]).toMatchObject({ phase: 'unresolved', outcome: null })
    const abandoned = apply(
      expired.state,
      event({
        kind: 'turn-recovery-started',
        turnId: 'turn-2',
        custodyId: 'custody-2',
        deadlineAt: 30
      })
    )
    const released = apply(
      abandoned.state,
      event({ kind: 'turn-recovery-abandoned', turnId: 'turn-2', custodyId: 'custody-2' })
    )
    expect(released.state.turns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ turnId: 'turn-2', phase: 'abandoned', outcome: null })
      ])
    )
  })

  it('deduplicates replay and keeps a stable completion identity', () => {
    const first = apply(
      state(),
      event({
        kind: 'turn-outcome-observed',
        turnId: 'turn-1',
        outcome: 'failed',
        recordKind: 'terminal-record'
      })
    )
    const replay = apply(first.state, {
      ...event({
        kind: 'turn-outcome-observed',
        turnId: 'turn-1',
        outcome: 'failed',
        recordKind: 'terminal-record'
      }),
      evidence: { ...first.state.appliedEvents[0], observedAt: first.state.turns[0].settledAt ?? 1 }
    })
    expect(first.committedOutcomes[0].completionId).toBeTruthy()
    expect(replay.disposition).toBe('duplicate')
    expect(replay.committedOutcomes).toEqual([])
  })

  it('does not expose mutable reducer records through a snapshot', () => {
    let current = state()
    current = apply(current, event({ kind: 'turn-started', turnId: 'turn-copy' })).state
    const snapshot = readAgentTurnLifecycleSnapshot(current)
    snapshot.turns[0].lastEvidence.eventId = 'mutated'
    expect(current.turns[0].lastEvidence.eventId).not.toBe('mutated')
    snapshot.owner.attachment.executionId = 'mutated'
    expect(current.owner.attachment.executionId).toBe('execution-c1')
  })

  it('copies the owner identity when the lifecycle state is created', () => {
    const mutableOwner: AgentTurnOwner = {
      ...owner,
      attachment: { executionId: 'execution-original' }
    }
    const current = createAgentTurnLifecycleState(mutableOwner)
    mutableOwner.attachment.executionId = 'execution-mutated'
    expect(current.owner.attachment.executionId).toBe('execution-original')
  })

  it('rejects malformed anonymous lifecycle identity before reducing', () => {
    const malformed = {
      kind: 'turn-outcome-observed',
      turnId: '',
      outcome: 'completed',
      recordKind: 'event',
      owner,
      evidence: { eventId: 'event-malformed', producerId: 'c1-test', observedAt: 1 }
    }
    expect(isAgentTurnLifecycleEvent(malformed)).toBe(false)
  })

  it('rejects inventories that assign one child to two lifecycle kinds', () => {
    const malformed = event({
      kind: 'current-turn-inventory',
      complete: true,
      currentTurn: {
        turnId: 'turn-duplicate-child',
        joinedChildren: [{ workId: 'child-1', phase: 'active' }],
        residentBackground: [{ workId: 'child-1', phase: 'active' }]
      }
    })
    expect(isAgentTurnLifecycleEvent(malformed)).toBe(false)
  })
})
