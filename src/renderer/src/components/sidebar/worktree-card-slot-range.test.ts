import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { HostScopedWorktreeKey } from '../../../../shared/worktree/host-qualified-identity'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { WorktreeLineageTree } from '../../../../shared/sidebar-list/worktree-lineage-range'
import { toLineageSlotRecord } from './worktree-card-slot-summary'
import { createLineageSlotReader, type WorkspaceSlot } from './worktree-card-slot-range'

// The reader's contract with invalidation: a snapshot per state, and either the changed workspace
// ids or null for a structural change. Tests drive both directly.
const invalidation = vi.hoisted(() => ({ changed: null as Set<string> | null }))
vi.mock('./worktree-card-slot-invalidation', () => ({
  slotSnapshot: (state: { snapshot: object }) => state.snapshot,
  changedSlotWorkspaces: () => invalidation.changed
}))

type FakeState = AppState & { snapshot: object; latest: Map<string, number> }

function makeState(latest: Map<string, number>): FakeState {
  return { snapshot: {}, latest } as unknown as FakeState
}

/** Root with one child at 0..1, then `siblings` leaf roots: a large section, a tiny lineage. */
function makeTree(siblings: number): WorktreeLineageTree {
  const size = 2 + siblings
  const identities = Array.from({ length: size }, (_, i) =>
    composeWorktreeHostIdentity('local', `w${i}`)
  )
  const ends = Array.from({ length: size }, (_, i) => (i === 0 ? 2 : i + 1))
  return { identities, worktrees: [] as Worktree[], ends }
}

function makeReader() {
  const calls: HostScopedWorktreeKey[] = []
  const reader = createLineageSlotReader((state, identity): WorkspaceSlot => {
    calls.push(identity)
    const at = (state as FakeState).latest.get(identity) ?? null
    return { targets: [], record: toLineageSlotRecord([]), latestAt: at }
  })
  return { reader, calls }
}

describe('createLineageSlotReader', () => {
  it.each([100, 1000])(
    'projects only the queried range after a structural change (section of %i)',
    (siblings) => {
      const tree = makeTree(siblings)
      const { reader, calls } = makeReader()
      const child = tree.identities[1]!
      const state = makeState(new Map([[child, 5]]))
      expect(reader.descendantSlot(state, tree, 0).latestAt).toBe(5)
      expect(calls).toEqual([child])

      calls.length = 0
      invalidation.changed = null
      const next = makeState(new Map([[child, 9]]))
      expect(reader.descendantSlot(next, tree, 0).latestAt).toBe(9)
      expect(calls).toEqual([child])
    }
  )

  it('does not project again for an unchanged snapshot', () => {
    const tree = makeTree(50)
    const { reader, calls } = makeReader()
    const state = makeState(new Map())
    reader.descendantSlot(state, tree, 0)
    calls.length = 0
    reader.descendantSlot(state, tree, 0)
    reader.descendantSlots(state, tree, 0)
    expect(calls).toEqual([])
  })

  it('re-projects only changed workspaces on a localized change', () => {
    const tree: WorktreeLineageTree = {
      identities: ['a', 'b', 'c', 'd'].map((id) => composeWorktreeHostIdentity('local', id)),
      worktrees: [],
      ends: [4, 4, 4, 4]
    }
    const { reader, calls } = makeReader()
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
    calls.length = 0
    invalidation.changed = new Set(['c'])
    const next = makeState(
      new Map([
        [b!, 1],
        [c!, 7],
        [d!, 3]
      ])
    )
    expect(reader.descendantSlot(next, tree, 0).latestAt).toBe(7)
    expect(calls).toEqual([c])
    expect(reader.descendantSlots(next, tree, 0).map((slot) => slot.latestAt)).toEqual([1, 7, 3])
  })

  it('re-projects one changed descendant in a 10,000-descendant range', () => {
    const size = 10_001
    const tree: WorktreeLineageTree = {
      identities: Array.from({ length: size }, (_, i) =>
        composeWorktreeHostIdentity('local', `n${i}`)
      ),
      worktrees: [],
      ends: Array.from({ length: size }, (_, i) => (i === 0 ? size : i + 1))
    }
    const { reader, calls } = makeReader()
    const changed = tree.identities[4321]!
    reader.descendantSlot(makeState(new Map()), tree, 0)
    calls.length = 0
    invalidation.changed = new Set(['n4321'])
    expect(reader.descendantSlot(makeState(new Map([[changed, 42]])), tree, 0).latestAt).toBe(42)
    expect(calls).toEqual([changed])
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
