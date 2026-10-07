// A status write costs what it touches: a parent publish or a child update must not grow with
// every other session's children. Ratios of interleaved medians, so a loaded machine slows both.

import { describe, expect, it } from 'vitest'
import type { AgentChildWorkInput } from './agent-status-child-work'
import { createAgentStatusStore, type AgentStatusStore } from './agent-status-store'
import { makeStructuredAgentStatusSubject, type AgentStatusSubject } from './agent-status-subject'

const CHILDREN_PER_PARENT = 40

function subjectFor(index: number): AgentStatusSubject {
  return makeStructuredAgentStatusSubject(
    { executionHostId: 'local', wslDistro: null, workspaceId: 'ws-1', workspaceKind: 'folder' },
    `session-${index}`
  )
}

function childOf(parent: AgentStatusSubject, id: string, observedAt: number): AgentChildWorkInput {
  return {
    childWorkId: id,
    parent,
    provider: 'claude',
    kind: 'agent',
    state: 'working',
    membership: 'live',
    firstObservedAt: 1,
    observedAt,
    stoppable: true,
    invocation: { invocationId: `toolu-${id}`, generation: 1 },
    provenance: { source: 'structured-session', producerId: 'scaling' },
    description: `Task ${id}`
  }
}

function storeWith(children: number): AgentStatusStore {
  const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
  for (let p = 0; p * CHILDREN_PER_PARENT < children; p += 1) {
    const parent = subjectFor(p)
    const batch = Array.from({ length: CHILDREN_PER_PARENT }, (_, c) =>
      childOf(parent, `child-${p}-${c}`, 1)
    )
    const committed = store.applyMutation({
      parent: { subject: parent },
      children: batch,
      aliases: batch.flatMap((child) =>
        (['task_id', 'tool_use_id'] as const).map((aliasKind) => ({
          parent,
          provider: 'claude',
          segmentId: 'scaling',
          kind: child.kind,
          aliasKind,
          alias: `${aliasKind}-${child.childWorkId}`,
          childWorkId: child.childWorkId,
          fence: child.invocation
        }))
      )
    })
    expect(committed).not.toBeNull()
  }
  return store
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]!
}

/** Median cost of `write` on each store, measured alternately so load lands on both. */
function interleavedMedians(
  stores: AgentStatusStore[],
  write: (store: AgentStatusStore, rep: number) => void
): number[] {
  const samples = stores.map((): number[] => [])
  for (let rep = 0; rep < 400; rep += 1) {
    for (const [index, store] of stores.entries()) {
      const started = performance.now()
      write(store, rep)
      // The first reps warm the JIT for both stores alike.
      if (rep >= 50) {
        samples[index]!.push(performance.now() - started)
      }
    }
  }
  return samples.map(median)
}

describe('AgentStatusStore write cost', () => {
  const parent = subjectFor(0)
  const small = storeWith(40)
  const large = storeWith(4_000)

  it('publishes a parent at 4,000 children for under 4x its cost at 40', () => {
    const [atSmall, atLarge] = interleavedMedians([small, large], (store, rep) => {
      store.applyMutation({
        parent: {
          subject: parent,
          status: {
            state: 'working',
            prompt: `prompt ${rep}`,
            paneKey: 'structured-pane',
            connectionId: null,
            receivedAt: rep,
            evidenceObservedAt: rep,
            stateStartedAt: 1,
            worktreeId: parent.workspaceId,
            structuredHost: 'owned'
          }
        }
      })
    })
    expect(atLarge! / atSmall!).toBeLessThan(4)
  })

  it('updates one child at 4,000 children for under 4x its cost at 40', () => {
    const [atSmall, atLarge] = interleavedMedians([small, large], (store, rep) => {
      store.applyMutation({ children: [childOf(parent, 'child-0-1', 2 + rep)] })
    })
    expect(atLarge! / atSmall!).toBeLessThan(4)
  })
})
