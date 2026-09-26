// The store applies mutations in place and re-validates only what they touched. Held to the
// copy-everything store it replaced: same decisions, same snapshots, same reads, every step.

import { describe, expect, it } from 'vitest'
import type { AgentChildWorkAliasInput } from './agent-status-child-work-alias'
import { serializeAgentChildWorkBindingKey } from './agent-status-child-work-binding'
import type { AgentChildWorkInput } from './agent-status-child-work'
import { createAgentStatusStore } from './agent-status-store'
import { parseAgentStatusStoreMutation } from './agent-status-store-codec'
import { commitAgentStatusStoreMutation } from './agent-status-store-commit'
import type { AgentStatusStoreMutation } from './agent-status-store-contract'
import { createCopyingAgentStatusStoreOracle } from './agent-status-store-copying-oracle.test-fixture'
import {
  indexAgentStatusStoreState,
  type AgentStatusStoreIndexes
} from './agent-status-store-indexes'
import {
  createEmptyAgentStatusStoreState,
  validateAgentStatusStoreState
} from './agent-status-store-state'
import {
  makeStructuredAgentStatusSubject,
  serializeAgentStatusSubject,
  type AgentStatusSubject
} from './agent-status-subject'

function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const parents: AgentStatusSubject[] = [0, 1, 2].map((index) =>
  makeStructuredAgentStatusSubject(
    { executionHostId: 'local', wslDistro: null, workspaceId: 'ws-1', workspaceKind: 'folder' },
    `session-${index}`
  )
)
// Wide enough that tombstoned ids (fenced for thousands of revisions) do not exhaust it.
const CHILD_IDS = Array.from({ length: 80 }, (_, index) => `child-${index}`)
const KINDS = ['agent', 'command'] as const
const FENCES = [
  { invocationId: 'run-1', generation: 1 },
  { invocationId: 'run-2', generation: 2 }
]

function mutations(random: () => number) {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  const child = (): AgentChildWorkInput => {
    const invocation = pick(FENCES)
    return {
      childWorkId: pick(CHILD_IDS),
      parent: pick(parents),
      provider: 'claude',
      kind: pick(KINDS),
      state: 'working',
      membership: 'live',
      // Mostly stable, so updates land; sometimes not, so the store refuses one.
      firstObservedAt: random() < 0.9 ? 1 : 2,
      observedAt: Math.floor(random() * 50),
      stoppable: random() < 0.5,
      invocation,
      ...(invocation.generation > 1
        ? { previousInvocations: [{ fence: FENCES[0]!, outcome: 'succeeded' as const }] }
        : {}),
      provenance: { source: 'structured-session', producerId: 'fuzz' },
      description: `d${Math.floor(random() * 4)}`
    }
  }
  const alias = (): AgentChildWorkAliasInput => ({
    parent: pick(parents),
    provider: 'claude',
    segmentId: 'segment',
    kind: pick(KINDS),
    aliasKind: pick(['task_id', 'tool_use_id'] as const),
    alias: `handle-${Math.floor(random() * 4)}`,
    childWorkId: pick(CHILD_IDS),
    fence: pick(FENCES)
  })
  const aliasOf = (bound: AgentChildWorkInput): AgentChildWorkAliasInput => ({
    ...alias(),
    parent: bound.parent,
    kind: bound.kind,
    childWorkId: bound.childWorkId,
    fence: bound.invocation
  })
  const fact = () => ({ subject: pick(parents), key: pick(['seen', 'pinned']), value: random() })
  const steps: (() => AgentStatusStoreMutation)[] = [
    () => ({ parent: { subject: pick(parents), firstObservedAt: 1 } }),
    () => ({ removeParent: pick(parents) }),
    () => ({ children: [child()] }),
    () => ({ children: [child(), child()], aliases: [alias()] }),
    () => ({ aliases: [alias(), alias()] }),
    ...Array.from({ length: 6 }, () => () => {
      const bound = child()
      return { parent: { subject: bound.parent }, children: [bound], aliases: [aliasOf(bound)] }
    }),
    () => ({ removeChildren: [pick(CHILD_IDS)] }),
    () => ({ removeAliases: [serializeAgentChildWorkBindingKey(alias())] }),
    () => ({ facts: [fact()] }),
    () => ({ removeFacts: [fact()] }),
    () => ({
      tombstones: [
        pick([
          { entity: 'child' as const, key: pick(CHILD_IDS) },
          { entity: 'parent' as const, key: serializeAgentStatusSubject(pick(parents)) },
          { entity: 'alias' as const, key: serializeAgentChildWorkBindingKey(alias()) }
        ])
      ]
    }),
    () => ({ removeParent: pick(parents), parent: { subject: pick(parents) }, children: [child()] })
  ]
  return () => pick(steps)()
}

/** Every index as data: sets sorted, and each table's keys in the order the index ranks them. */
function indexContents(indexes: AgentStatusStoreIndexes) {
  const sets = (index: Map<string, Set<string>>) =>
    [...index].map(([key, values]) => [key, [...values].sort()]).sort()
  const ranked = (order: Map<string, number>) =>
    [...order].sort((left, right) => left[1] - right[1]).map(([key]) => key)
  return {
    recordBytes: indexes.recordBytes,
    childrenByParent: sets(indexes.childrenByParent),
    factsByParent: sets(indexes.factsByParent),
    aliasesByChild: sets(indexes.aliasesByChild),
    aliasesByIdentity: sets(indexes.aliasesByIdentity),
    retiredAliasesByIdentity: sets(indexes.retiredAliasesByIdentity),
    order: {
      children: ranked(indexes.order.children),
      aliases: ranked(indexes.order.aliases),
      facts: ranked(indexes.order.facts),
      tombstones: ranked(indexes.order.tombstones)
    }
  }
}

describe('AgentStatusStore applied in place', () => {
  it.each([1, 7, 42, 1_234])(
    'matches the copying store decision for decision (seed %i)',
    (seed) => {
      const random = seeded(seed)
      const next = mutations(random)
      const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
      const replica = createAgentStatusStore({ epoch: 'epoch-a', mode: 'replica' })
      const oracle = createCopyingAgentStatusStoreOracle('epoch-a')
      expect(replica.applySnapshot(store.getSnapshot())).toBe(true)
      let accepted = 0
      let mostAliases = 0
      for (let step = 0; step < 1_500; step += 1) {
        const mutation = next()
        const envelope = store.applyMutation(mutation)
        expect({ step, accepted: envelope !== null }).toEqual({
          step,
          accepted: oracle.applyMutation(mutation)
        })
        if (envelope) {
          accepted += 1
          expect(replica.applyTransportEnvelope(envelope)).toBe(true)
        }
        expect(validateAgentStatusStoreState(oracle.state())).toBe(true)
        expect(JSON.stringify(store.getSnapshot())).toBe(JSON.stringify(oracle.getSnapshot()))
        for (const parent of parents) {
          expect(store.getChildren(parent)).toEqual(oracle.getChildren(parent))
        }
        for (const id of CHILD_IDS) {
          expect(store.getAliasesForChild(id)).toEqual(oracle.getAliasesForChild(id))
        }
        mostAliases = Math.max(mostAliases, oracle.state().aliases.size)
        const probe = mutation.aliases ?? []
        expect(store.resolveChildAliases(probe)).toEqual(oracle.resolveChildAliases(probe))
      }
      expect(JSON.stringify(replica.getSnapshot())).toBe(JSON.stringify(store.getSnapshot()))
      // The run exercises both outcomes, not only refusals.
      expect(accepted).toBeGreaterThan(300)
      expect(accepted).toBeLessThan(1_450)
      expect(mostAliases).toBeGreaterThan(4)
    },
    60_000
  )

  it.each([3, 99])(
    'keeps every index equal to one rebuilt from the maps, refusals included (seed %i)',
    (seed) => {
      const next = mutations(seeded(seed))
      const state = createEmptyAgentStatusStoreState('epoch-a')
      const indexes = indexAgentStatusStoreState(state)
      for (let step = 0; step < 1_500; step += 1) {
        const mutation = parseAgentStatusStoreMutation(next())
        if (mutation) {
          commitAgentStatusStoreMutation(state, indexes, mutation, state.revision + 1)
        }
        // The running byte total is only observable at the budget, so it is held to a rebuild.
        expect({ step, ...indexContents(indexes) }).toEqual({
          step,
          ...indexContents(indexAgentStatusStoreState(state))
        })
      }
    },
    60_000
  )

  it('compacts tombstones exactly as the copying store does past the retention window', () => {
    const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    const oracle = createCopyingAgentStatusStoreOracle('epoch-a')
    const parent = parents[0]!
    for (let step = 0; step < 5_000; step += 1) {
      const mutation: AgentStatusStoreMutation =
        step % 2 === 0
          ? { parent: { subject: parent }, facts: [{ subject: parent, key: `k${step}`, value: 1 }] }
          : { removeFacts: [{ subject: parent, key: `k${step - 1}` }] }
      expect(store.applyMutation(mutation) !== null).toBe(oracle.applyMutation(mutation))
    }
    expect(oracle.getSnapshot().tombstones.length).toBeGreaterThan(1_000)
    expect(JSON.stringify(store.getSnapshot())).toBe(JSON.stringify(oracle.getSnapshot()))
  }, 60_000)
})
