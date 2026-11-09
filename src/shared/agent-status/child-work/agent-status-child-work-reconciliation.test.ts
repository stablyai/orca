import { describe, expect, it } from 'vitest'
import { createAgentChildWorkAdmission } from './agent-status-child-work-admission'
import type { AgentChildWorkRecord } from './agent-status-child-work'
import type {
  AgentChildWorkEvidence,
  AgentChildWorkLiveObservation
} from './agent-status-child-work-evidence'
import { reconcileAgentChildWorkEvidence } from './agent-status-child-work-reconciliation'
import { createAgentStatusStore, type AgentStatusStore } from '../store/agent-status-store'
import { makeStructuredAgentStatusSubject } from '../contracts/agent-status-subject'

const parent = makeStructuredAgentStatusSubject(
  { executionHostId: 'local', wslDistro: null, workspaceId: 'ws-1', workspaceKind: 'folder' },
  'session-1'
)

function child(
  id: string,
  overrides: Partial<AgentChildWorkLiveObservation> = {}
): AgentChildWorkLiveObservation {
  return {
    handle: { idKind: 'task_id', id, runId: `toolu_${id}` },
    kind: 'agent',
    residency: 'background',
    state: 'working',
    name: 'general-purpose',
    description: `Task ${id}`,
    stoppable: true,
    ...overrides
  }
}

function live(
  observation: AgentChildWorkLiveObservation,
  observedAt = 100
): AgentChildWorkEvidence {
  return { type: 'live', observedAt, child: observation }
}

function harness() {
  const store = createAgentStatusStore({ epoch: 'epoch-1', mode: 'authority' })
  expect(store.applyMutation({ parent: { subject: parent } })).not.toBeNull()
  let minted = 0
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: () => `child-${++minted}`
  })
  const apply = (...evidence: AgentChildWorkEvidence[]) =>
    reconcileAgentChildWorkEvidence({ store, admission, parent, provider: 'claude', evidence })
  return { store, apply }
}

function records(store: AgentStatusStore): AgentChildWorkRecord[] {
  return store.getChildren(parent)
}

function only(store: AgentStatusStore): AgentChildWorkRecord {
  const [record, ...rest] = records(store)
  expect(rest).toEqual([])
  return record
}

describe('structured child-work reconciliation', () => {
  it('resumes the same child as a new run when the provider spawns it again', () => {
    const { store, apply } = harness()
    apply(live(child('task-a')))
    apply({
      type: 'ended',
      observedAt: 200,
      handle: { idKind: 'task_id', id: 'task-a' },
      outcome: 'succeeded'
    })
    apply(
      live(child('task-a', { handle: { idKind: 'task_id', id: 'task-a', runId: 'toolu_2' } }), 300)
    )
    expect(only(store)).toMatchObject({
      childWorkId: 'child-1',
      membership: 'live',
      firstObservedAt: 100,
      invocation: { invocationId: 'toolu_2', generation: 2 },
      previousInvocations: [
        {
          fence: { invocationId: 'toolu_task-a', generation: 1 },
          outcome: 'succeeded',
          settledAt: 200
        }
      ]
    })
    // A late frame from the first run neither ends nor restarts the second.
    apply(live(child('task-a'), 310))
    apply({
      type: 'ended',
      observedAt: 320,
      handle: { idKind: 'task_id', id: 'task-a', runId: 'toolu_task-a' },
      outcome: 'failed'
    })
    expect(only(store)).toMatchObject({
      membership: 'live',
      invocation: { invocationId: 'toolu_2', generation: 2 }
    })
  })

  it('changes only the records its own producer admitted', () => {
    const { store, apply } = harness()
    const admission = createAgentChildWorkAdmission(store, { mintChildWorkId: () => 'foreign' })
    admission.announce({
      parent,
      provider: 'claude',
      aliases: [{ segmentId: 'another-producer', aliasKind: 'task_id', alias: 'task-a' }],
      fence: { invocationId: 'toolu_task-a', generation: 1 },
      lifetime: 'current',
      kind: 'agent',
      state: 'working',
      membership: 'live',
      residency: 'foreground',
      observedAt: 50,
      stoppable: true,
      // Same source, same parent and provider: only the producer differs.
      provenance: { source: 'structured-session', producerId: 'another-producer' }
    })
    apply(live(child('task-a')), { type: 'session-ended', observedAt: 170 })
    expect(records(store)).toEqual([
      expect.objectContaining({ childWorkId: 'foreign', membership: 'live' }),
      expect.objectContaining({ membership: 'settled', outcome: 'unknown' })
    ])
  })

  it("lets the child's own ending replace an acknowledged Stop's, and nothing else replace its own", () => {
    const ended = (
      id: string,
      outcome: 'succeeded' | 'failed' | 'cancelled',
      observedAt: number,
      extra: Partial<Extract<AgentChildWorkEvidence, { type: 'ended' }>> = {}
    ): AgentChildWorkEvidence => ({
      type: 'ended',
      observedAt,
      handle: { idKind: 'task_id', id },
      outcome,
      ...extra
    })
    const { store, apply } = harness()
    apply(live(child('replaced')), live(child('kept')), live(child('same')))
    const stopped = (id: string, observedAt: number): AgentChildWorkEvidence => {
      const record = records(store).find((candidate) => candidate.description === `Task ${id}`)!
      return {
        type: 'stop-acknowledged',
        observedAt,
        childWorkId: record.childWorkId,
        handleId: id,
        invocation: record.invocation
      }
    }
    apply(stopped('replaced', 101))
    apply(ended('replaced', 'succeeded', 102, { lastMessage: 'all tests passed' }))
    apply(ended('kept', 'failed', 101, { lastMessage: 'Exit code 1' }))
    apply(stopped('kept', 102))
    apply(stopped('same', 101))
    apply(ended('same', 'cancelled', 102))
    expect(
      records(store).map((record) => [
        record.description,
        record.outcome,
        record.outcomeBasis ?? 'reported',
        record.lastMessage ?? null
      ])
    ).toEqual([
      ['Task replaced', 'succeeded', 'reported', 'all tests passed'],
      ['Task kept', 'failed', 'reported', 'Exit code 1'],
      ['Task same', 'cancelled', 'reported', null]
    ])
    // Once the child reported its ending, a later acknowledged Stop changes nothing either.
    expect(apply(stopped('same', 103))).toMatchObject({ settled: 0 })
  })
})
