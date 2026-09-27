import { describe, expect, it } from 'vitest'
import { createAgentChildWorkAdmission } from './agent-status-child-work-admission'
import type { AgentChildWorkRecord } from './agent-status-child-work'
import type {
  AgentChildWorkEvidence,
  AgentChildWorkLiveObservation
} from './agent-status-child-work-evidence'
import {
  reconcileAgentChildWorkEvidence,
  STRUCTURED_CHILD_WORK_MAX_SETTLED
} from './agent-status-child-work-reconciliation'
import { STRUCTURED_CHILD_WORK_MAX_LIVE } from './agent-status-child-work-evidence-admission'
import { createAgentStatusStore, type AgentStatusStore } from './agent-status-store'
import { makeStructuredAgentStatusSubject } from './agent-status-subject'

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
  it('records a live child once, under its task id and the spawn call of its first run', () => {
    const { store, apply } = harness()
    expect(apply(live(child('task-a')))).toMatchObject({ admitted: 1, rejected: [] })
    expect(only(store)).toMatchObject({
      childWorkId: 'child-1',
      kind: 'agent',
      state: 'working',
      membership: 'live',
      residency: 'background',
      firstObservedAt: 100,
      observedAt: 100,
      invocation: { invocationId: 'toolu_task-a', generation: 1 }
    })
    expect(
      store
        .getAliasesForChild('child-1')
        .map(({ aliasKind, alias }) => `${aliasKind}:${alias}`)
        .sort()
    ).toEqual(['task_id:task-a', 'tool_use_id:toolu_task-a'])
  })

  it('keeps one child when it is first named before its spawn call is known', () => {
    const { store, apply } = harness()
    apply(live(child('task-a', { handle: { idKind: 'task_id', id: 'task-a' } })))
    apply(live(child('task-a'), 110))
    // The first spawn call it reports belongs to the run already recorded, not a new one.
    expect(only(store)).toMatchObject({
      childWorkId: 'child-1',
      invocation: { invocationId: 'task-a', generation: 1 },
      observedAt: 110
    })
    // The raw spawn id and the task id name the same child to an owner lookup.
    apply(live(child('shell-1', { kind: 'command', ownerId: 'toolu_task-a' }), 120))
    apply(live(child('shell-2', { kind: 'command', ownerId: 'task-a' }), 120))
    expect(records(store).map((record) => record.parentChildWorkId)).toEqual([
      undefined,
      'child-1',
      'child-1'
    ])
  })

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

  it('refines an ending nobody classified with the outcome reported after it', () => {
    const { store, apply } = harness()
    apply(live(child('task-a')), live(child('task-b'), 100))
    apply({
      type: 'ended',
      observedAt: 200,
      handle: { idKind: 'task_id', id: 'task-a' },
      outcome: 'unknown'
    })
    expect(records(store)[0]).toMatchObject({
      membership: 'settled',
      state: 'done',
      outcome: 'unknown',
      settledAt: 200
    })
    apply({
      type: 'ended',
      observedAt: 201,
      handle: { idKind: 'task_id', id: 'task-a' },
      outcome: 'succeeded',
      lastMessage: 'All tests pass',
      totalTokens: 19_003
    })
    expect(records(store)[0]).toMatchObject({
      membership: 'settled',
      outcome: 'succeeded',
      settledAt: 200,
      observedAt: 201,
      lastMessage: 'All tests pass',
      totalTokens: 19_003
    })
    // The second terminal frame for the same ending changes nothing it already said.
    apply({
      type: 'ended',
      observedAt: 202,
      handle: { idKind: 'task_id', id: 'task-a' },
      outcome: 'failed'
    })
    expect(records(store)[0]).toMatchObject({ outcome: 'succeeded' })
    expect(records(store)[1]).toMatchObject({ membership: 'live' })
  })

  it('opens a new run when the producer reports a restart, even under the same run handle', () => {
    const { store, apply } = harness()
    apply(live(child('task-a')), {
      type: 'ended',
      observedAt: 200,
      handle: { idKind: 'task_id', id: 'task-a' },
      outcome: 'succeeded'
    })
    // A late live edge from the run that ended is not a restart.
    apply(live(child('task-a'), 250))
    expect(only(store)).toMatchObject({ membership: 'settled', invocation: { generation: 1 } })
    apply({ type: 'live', observedAt: 300, child: child('task-a'), restart: true })
    expect(only(store)).toMatchObject({
      membership: 'live',
      invocation: { invocationId: 'toolu_task-a', generation: 2 },
      previousInvocations: [expect.objectContaining({ outcome: 'succeeded' })]
    })
  })

  it('ends the current run on an ending whose run handle it never saw', () => {
    const { store, apply } = harness()
    apply(live(child('task-a')), {
      type: 'ended',
      observedAt: 200,
      handle: { idKind: 'task_id', id: 'task-a', runId: 'toolu_unseen' },
      outcome: 'failed'
    })
    expect(only(store)).toMatchObject({
      membership: 'settled',
      outcome: 'failed',
      invocation: { invocationId: 'toolu_task-a', generation: 1 }
    })
  })

  it('carries the reported operation until the next report or the ending', () => {
    const { store, apply } = harness()
    const bash = { toolName: 'Bash', basis: 'reported', observedAt: 110 } as const
    apply(live(child('task-a', { operation: bash, lastMessage: 'Running tests' }), 110))
    apply(live(child('task-a'), 120))
    expect(only(store)).toMatchObject({ operation: bash, lastMessage: 'Running tests' })
    // An end-of-operation edge closes an open operation only; a report has no end edge.
    apply(live(child('task-a', { operation: null }), 130))
    expect(only(store).operation).toEqual(bash)
    apply(
      live(
        child('task-a', { operation: { toolName: 'Edit', basis: 'open', observedAt: 140 } }),
        140
      ),
      live(child('task-a', { operation: null }), 150)
    )
    expect(only(store).operation).toBeUndefined()
    apply(live(child('task-a', { operation: bash }), 160), {
      type: 'ended',
      observedAt: 170,
      handle: { idKind: 'task_id', id: 'task-a' },
      outcome: 'failed'
    })
    expect(only(store)).toMatchObject({ outcome: 'failed', lastMessage: 'Running tests' })
    expect(only(store).operation).toBeUndefined()
  })

  it("sets a live child's open call by any handle it answers to, and never creates a child", () => {
    const { store, apply } = harness()
    const bash = { toolName: 'Bash', input: 'npm test', basis: 'open', observedAt: 110 } as const
    apply({ type: 'operation', observedAt: 110, childId: 'nobody', operation: bash })
    expect(records(store)).toEqual([])
    apply(live(child('task-a')), {
      type: 'operation',
      observedAt: 110,
      childId: 'toolu_task-a',
      operation: bash
    })
    expect(only(store)).toMatchObject({
      operation: bash,
      observedAt: 110,
      description: 'Task task-a',
      invocation: { generation: 1 }
    })
    apply({ type: 'operation', observedAt: 120, childId: 'task-a', operation: null })
    expect(only(store).operation).toBeUndefined()
    apply(
      {
        type: 'ended',
        observedAt: 130,
        handle: { idKind: 'task_id', id: 'task-a' },
        outcome: 'succeeded'
      },
      { type: 'operation', observedAt: 140, childId: 'task-a', operation: bash }
    )
    expect(only(store)).toMatchObject({ membership: 'settled', observedAt: 130 })
    expect(only(store).operation).toBeUndefined()
  })

  it('hands raw provider labels to admission, which folds them to one line', () => {
    const { store, apply } = harness()
    const result = apply(
      live(child('task-a', { description: 'Audit\nthe\ttests\u0007 ', name: ' reviewer\n' }))
    )
    expect(result.rejected).toEqual([])
    expect(only(store)).toMatchObject({ description: 'Audit the tests', name: 'reviewer' })
  })

  it('settles every child still live when the provider session ends, and keeps them all', () => {
    const { store, apply } = harness()
    apply(live(child('task-a')), live(child('task-b'), 110), {
      type: 'ended',
      observedAt: 150,
      handle: { idKind: 'task_id', id: 'task-b' },
      outcome: 'succeeded'
    })
    expect(apply({ type: 'session-ended', observedAt: 200 })).toMatchObject({
      settled: 1,
      removed: 0
    })
    expect(
      records(store).map(({ membership, outcome, settledAt }) => ({
        membership,
        outcome,
        settledAt
      }))
    ).toEqual([
      { membership: 'settled', outcome: 'unknown', settledAt: 200 },
      { membership: 'settled', outcome: 'succeeded', settledAt: 150 }
    ])
    // Its own outcome, arriving late, still refines the unreported ending.
    apply({
      type: 'ended',
      observedAt: 210,
      handle: { idKind: 'task_id', id: 'task-a' },
      outcome: 'cancelled'
    })
    expect(records(store)[0]).toMatchObject({ outcome: 'cancelled', settledAt: 200 })
  })

  it('fences a removed lifetime with its old bindings, and frees the id for a new one', () => {
    const { store, apply } = harness()
    apply(live(child('task-a')))
    expect(store.applyMutation({ removeChildren: [only(store).childWorkId] })).not.toBeNull()
    expect(records(store)).toEqual([])
    apply(live(child('task-a'), 300))
    expect(only(store)).toMatchObject({
      membership: 'live',
      invocation: { invocationId: 'toolu_task-a', generation: 2 }
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

  it('refuses a child whose parent the store does not hold', () => {
    const { store, apply } = harness()
    store.applyMutation({ removeParent: parent })
    expect(apply(live(child('task-a'))).rejected).toEqual([
      { handleId: 'task-a', reason: 'invalid' }
    ])
    expect(records(store)).toEqual([])
  })

  it('refuses a handle two of its own records answer to rather than guessing', () => {
    const { store, apply } = harness()
    apply(live(child('task-a')), live(child('task-b')))
    // Bind task-b's record to task-a's handle too, the way a corrupted join would.
    const [first, second] = records(store)
    const bound = store
      .getAliasesForChild(first.childWorkId)
      .filter((alias) => alias.aliasKind === 'task_id')
      .map(({ revision: _revision, ...alias }) => ({
        ...alias,
        childWorkId: second.childWorkId,
        fence: second.invocation
      }))
    expect(bound).toHaveLength(1)
    expect(store.applyMutation({ aliases: bound })).not.toBeNull()
    expect(apply(live(child('task-a'), 200)).rejected).toEqual([
      { handleId: 'task-a', reason: 'ambiguous' }
    ])
  })

  it('bounds the live children one session may admit', () => {
    const { store, apply } = harness()
    apply(
      ...Array.from({ length: STRUCTURED_CHILD_WORK_MAX_LIVE }, (_, index) =>
        live(child(`task-${index}`))
      )
    )
    expect(apply(live(child('one-too-many'))).rejected).toEqual([
      { handleId: 'one-too-many', reason: 'ingestion-limit' }
    ])
    expect(records(store)).toHaveLength(STRUCTURED_CHILD_WORK_MAX_LIVE)
  })

  it('keeps a bounded settled history, never dropping a child that owns live work', () => {
    const { store, apply } = harness()
    apply(live(child('owner')))
    apply(live(child('shell', { kind: 'command', ownerId: 'owner' })))
    apply({
      type: 'ended',
      observedAt: 101,
      handle: { idKind: 'task_id', id: 'owner' },
      outcome: 'succeeded'
    })
    for (let index = 0; index < STRUCTURED_CHILD_WORK_MAX_SETTLED + 1; index += 1) {
      apply(live(child(`done-${index}`), 200 + index), {
        type: 'ended',
        observedAt: 200 + index,
        handle: { idKind: 'task_id', id: `done-${index}` },
        outcome: 'succeeded'
      })
    }
    const settled = records(store).filter((record) => record.membership === 'settled')
    expect(settled).toHaveLength(STRUCTURED_CHILD_WORK_MAX_SETTLED)
    expect(settled.map((record) => record.description)).toContain('Task owner')
    expect(settled.map((record) => record.description)).not.toContain('Task done-0')
    expect(settled.map((record) => record.description)).not.toContain('Task done-1')
  })
})
