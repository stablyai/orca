import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { WorktreeLineageTree } from '../../../../shared/sidebar-list/worktree-lineage-range'
import { toLineageSlotRecord } from './worktree-card-slot-summary'
import { createLineageSlotReader, type WorkspaceSlot } from './worktree-card-slot-range'

// The reader's contract with invalidation: a snapshot per state, and either the changed workspace
// ids or null for a structural change. Tests drive both directly.
const invalidation = vi.hoisted<{ changed: Set<string> | null }>(() => ({ changed: null }))
vi.mock('./worktree-card-slot-invalidation', () => ({
  slotSnapshot: (state: { snapshot: object }) => state.snapshot,
  changedSlotWorkspaces: () => invalidation.changed
}))

const latestByState = new WeakMap<AppState, Map<string, number>>()

function makeState(latest: Map<string, number>): AppState & { snapshot: object } {
  const state = { ...useAppStore.getInitialState(), snapshot: {} }
  latestByState.set(state, latest)
  return state
}

/** Root with one child at 0..1, then `siblings` leaf roots: a large section, a tiny lineage. */
function makeTree(siblings: number): WorktreeLineageTree {
  const size = 2 + siblings
  const identities = Array.from({ length: size }, (_, i) =>
    composeWorktreeHostIdentity('local', `w${i}`)
  )
  const ends = Array.from({ length: size }, (_, i) => (i === 0 ? 2 : i + 1))
  return { identities, worktrees: [], ends }
}

function makeReader() {
  const reader = createLineageSlotReader((state, identity): WorkspaceSlot => {
    const at = latestByState.get(state)?.get(identity) ?? null
    return { targets: [], record: toLineageSlotRecord([]), latestAt: at }
  })
  return { reader }
}

describe('createLineageSlotReader', () => {
  it('refreshes the queried range after a structural change', () => {
    const tree = makeTree(2)
    const { reader } = makeReader()
    const child = tree.identities[1]!
    const state = makeState(new Map([[child, 5]]))
    expect(reader.descendantSlot(state, tree, 0).latestAt).toBe(5)

    invalidation.changed = null
    const next = makeState(new Map([[child, 9]]))
    expect(reader.descendantSlot(next, tree, 0).latestAt).toBe(9)
  })

  it('refreshes slot values after a localized change', () => {
    const tree: WorktreeLineageTree = {
      identities: ['a', 'b', 'c', 'd'].map((id) => composeWorktreeHostIdentity('local', id)),
      worktrees: [],
      ends: [4, 4, 4, 4]
    }
    const { reader } = makeReader()
    const [, b, c, d] = tree.identities
    reader.descendantSlot(
      makeState(
        new Map([
          [b!, 1],
          [c!, 2],
          [d!, 3]
        ])
      ),
      tree,
      0
    )
    invalidation.changed = new Set(['c'])
    const next = makeState(
      new Map([
        [b!, 1],
        [c!, 7],
        [d!, 3]
      ])
    )
    expect(reader.descendantSlot(next, tree, 0).latestAt).toBe(7)
    expect(reader.descendantSlots(next, tree, 0).map((slot) => slot.latestAt)).toEqual([1, 7, 3])
  })

  it('refreshes an aggregate when a descendant changes', () => {
    const size = 5
    const tree: WorktreeLineageTree = {
      identities: Array.from({ length: size }, (_, i) =>
        composeWorktreeHostIdentity('local', `n${i}`)
      ),
      worktrees: [],
      ends: Array.from({ length: size }, (_, i) => (i === 0 ? size : i + 1))
    }
    const { reader } = makeReader()
    const changed = tree.identities[3]!
    reader.descendantSlot(makeState(new Map()), tree, 0)
    invalidation.changed = new Set(['n3'])
    expect(reader.descendantSlot(makeState(new Map([[changed, 42]])), tree, 0).latestAt).toBe(42)
  })

  it('aggregates fresh and lazily refreshed slots across nested ranges', () => {
    // a ─ b ─ c, then d: reading b's range first must not leave a's aggregate stale.
    const tree: WorktreeLineageTree = {
      identities: ['a', 'b', 'c', 'd'].map((id) => composeWorktreeHostIdentity('local', id)),
      worktrees: [],
      ends: [3, 3, 3, 4]
    }
    const { reader } = makeReader()
    const [, b, c] = tree.identities
    invalidation.changed = null
    const state = makeState(
      new Map([
        [b!, 4],
        [c!, 6]
      ])
    )
    expect(reader.descendantSlot(state, tree, 1).latestAt).toBe(6)
    expect(reader.descendantSlot(state, tree, 0).latestAt).toBe(6)
    const next = makeState(
      new Map([
        [b!, 8],
        [c!, 6]
      ])
    )
    expect(reader.descendantSlot(next, tree, 0).latestAt).toBe(8)
    expect(reader.descendantSlot(next, tree, 1).latestAt).toBe(6)
  })
})
