import { useCallback, useState } from 'react'

/**
 * Expand/collapse state for a WorktreeCard's inline agent list:
 *  - `collapsedLineageParents`: agent-lineage parent paneKeys the user folded.
 *  - `compactRootListExpanded`: whether the "N agents" compact summary is open.
 */
export type WorktreeAgentExpansionState = {
  collapsedLineageParents: ReadonlySet<string>
  compactRootListExpanded: boolean
}

const EMPTY_COLLAPSED_PARENTS: ReadonlySet<string> = new Set()

const DEFAULT_EXPANSION_STATE: WorktreeAgentExpansionState = {
  collapsedLineageParents: EMPTY_COLLAPSED_PARENTS,
  compactRootListExpanded: false
}

// Why: the inline agent list's expand/collapse must outlive the WorktreeCard
// remount that fires (a) when the sidebar virtualizer recycles the row on
// scroll and (b) when the sibling child-worktrees section toggles — that toggle
// flips the card between an `item` and a `lineage-group` render row, changing
// its virtual-row key and forcing a fresh mount. Holding this in plain local
// useState reset it on every such remount, so folding one section visibly
// re-expanded the other. Renderer-only and LRU-bounded: it resets on reload,
// matching the ephemeral live-agent lineage it tracks, and never grows without
// bound in a long-lived renderer.
export const MAX_PERSISTED_WORKTREE_AGENT_EXPANSIONS = 512
const expansionByWorktreeId = new Map<string, WorktreeAgentExpansionState>()

function trimPersistedExpansions(): void {
  while (expansionByWorktreeId.size > MAX_PERSISTED_WORKTREE_AGENT_EXPANSIONS) {
    const oldest = expansionByWorktreeId.keys().next().value
    if (oldest === undefined) {
      break
    }
    expansionByWorktreeId.delete(oldest)
  }
}

function readExpansionState(worktreeId: string): WorktreeAgentExpansionState {
  return expansionByWorktreeId.get(worktreeId) ?? DEFAULT_EXPANSION_STATE
}

function persistExpansionState(worktreeId: string, state: WorktreeAgentExpansionState): void {
  // Re-insert to refresh LRU order; drop entries that carry no non-default
  // state so idle worktrees never occupy a slot.
  expansionByWorktreeId.delete(worktreeId)
  if (state.compactRootListExpanded || state.collapsedLineageParents.size > 0) {
    expansionByWorktreeId.set(worktreeId, state)
    trimPersistedExpansions()
  }
}

export type WorktreeAgentExpansionControls = {
  collapsedLineageParents: ReadonlySet<string>
  compactRootListExpanded: boolean
  /** Fold/unfold a single agent-lineage parent by its paneKey. */
  toggleLineageParent: (paneKey: string) => void
  /** Open/close the compact multi-agent summary panel. */
  toggleCompactRootList: () => void
}

/**
 * Remount-durable expand/collapse state for one worktree card's inline agent
 * list. Reads seed from a module-level, session-scoped cache so a virtualizer
 * recycle or a sibling child-worktrees toggle no longer wipes the user's
 * disclosure choices. Independent per worktree id.
 */
export function useWorktreeAgentExpansionState(worktreeId: string): WorktreeAgentExpansionControls {
  const [rendered, setRendered] = useState<{
    worktreeId: string
    state: WorktreeAgentExpansionState
  }>(() => ({ worktreeId, state: readExpansionState(worktreeId) }))

  // Why: a memoized body can be handed a new worktreeId without remounting;
  // fall back to the cache so we never show a stale card's disclosure.
  const current =
    rendered.worktreeId === worktreeId ? rendered.state : readExpansionState(worktreeId)

  const commit = useCallback(
    (next: WorktreeAgentExpansionState) => {
      persistExpansionState(worktreeId, next)
      setRendered({ worktreeId, state: next })
    },
    [worktreeId]
  )

  const toggleLineageParent = useCallback(
    (paneKey: string) => {
      const base = readExpansionState(worktreeId)
      const nextParents = new Set(base.collapsedLineageParents)
      if (nextParents.has(paneKey)) {
        nextParents.delete(paneKey)
      } else {
        nextParents.add(paneKey)
      }
      commit({ ...base, collapsedLineageParents: nextParents })
    },
    [commit, worktreeId]
  )

  const toggleCompactRootList = useCallback(() => {
    const base = readExpansionState(worktreeId)
    commit({ ...base, compactRootListExpanded: !base.compactRootListExpanded })
  }, [commit, worktreeId])

  return {
    collapsedLineageParents: current.collapsedLineageParents,
    compactRootListExpanded: current.compactRootListExpanded,
    toggleLineageParent,
    toggleCompactRootList
  }
}

export function clearWorktreeAgentExpansionStateForTests(): void {
  expansionByWorktreeId.clear()
}

export function getWorktreeAgentExpansionCountForTests(): number {
  return expansionByWorktreeId.size
}

export function seedWorktreeAgentExpansionStateForTests(
  worktreeId: string,
  state: WorktreeAgentExpansionState
): void {
  persistExpansionState(worktreeId, state)
}
