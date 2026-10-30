import { useCallback, useState } from 'react'

export type WorktreeAgentExpansionState = {
  collapsedLineageParents: ReadonlySet<string>
  compactRootListExpanded: boolean
}

const EMPTY_COLLAPSED_PARENTS: ReadonlySet<string> = new Set()

const DEFAULT_EXPANSION_STATE: WorktreeAgentExpansionState = {
  collapsedLineageParents: EMPTY_COLLAPSED_PARENTS,
  compactRootListExpanded: false
}

// Retain disclosures across virtualizer/lineage remounts in a bounded renderer-session cache; reload resets them.
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
  // Refresh LRU order and retain only non-default disclosures.
  expansionByWorktreeId.delete(worktreeId)
  if (state.compactRootListExpanded || state.collapsedLineageParents.size > 0) {
    expansionByWorktreeId.set(worktreeId, state)
    trimPersistedExpansions()
  }
}

export type WorktreeAgentExpansionControls = {
  collapsedLineageParents: ReadonlySet<string>
  compactRootListExpanded: boolean
  toggleLineageParent: (paneKey: string) => void
  toggleCompactRootList: () => void
}

/** Restore each worktree’s disclosures across virtualizer and sibling-lineage remounts. */
export function useWorktreeAgentExpansionState(worktreeId: string): WorktreeAgentExpansionControls {
  const [rendered, setRendered] = useState<{
    worktreeId: string
    state: WorktreeAgentExpansionState
  }>(() => ({ worktreeId, state: readExpansionState(worktreeId) }))

  // Memoized bodies can change worktree without remounting; avoid displaying the previous card’s disclosure.
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
