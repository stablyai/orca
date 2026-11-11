import { useCallback, useState } from 'react'

export type WorktreeAgentExpansionState = {
  // Child lists start collapsed so spawning subagents cannot grow the card and shift the sidebar.
  expandedLineageParents: ReadonlySet<string>
  expandedIdleChildGroups: ReadonlySet<string>
  compactRootListExpanded: boolean
}

const EMPTY_PANE_KEYS: ReadonlySet<string> = new Set()

const DEFAULT_EXPANSION_STATE: WorktreeAgentExpansionState = {
  expandedLineageParents: EMPTY_PANE_KEYS,
  expandedIdleChildGroups: EMPTY_PANE_KEYS,
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
  if (
    state.compactRootListExpanded ||
    state.expandedLineageParents.size > 0 ||
    state.expandedIdleChildGroups.size > 0
  ) {
    expansionByWorktreeId.set(worktreeId, state)
    trimPersistedExpansions()
  }
}

function toggleKey(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(keys)
  if (!next.delete(key)) {
    next.add(key)
  }
  return next
}

export type WorktreeAgentExpansionControls = {
  expandedLineageParents: ReadonlySet<string>
  expandedIdleChildGroups: ReadonlySet<string>
  compactRootListExpanded: boolean
  toggleLineageParent: (paneKey: string) => void
  toggleIdleChildGroup: (parentPaneKey: string) => void
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
      commit({ ...base, expandedLineageParents: toggleKey(base.expandedLineageParents, paneKey) })
    },
    [commit, worktreeId]
  )

  const toggleIdleChildGroup = useCallback(
    (parentPaneKey: string) => {
      const base = readExpansionState(worktreeId)
      commit({
        ...base,
        expandedIdleChildGroups: toggleKey(base.expandedIdleChildGroups, parentPaneKey)
      })
    },
    [commit, worktreeId]
  )

  const toggleCompactRootList = useCallback(() => {
    const base = readExpansionState(worktreeId)
    commit({ ...base, compactRootListExpanded: !base.compactRootListExpanded })
  }, [commit, worktreeId])

  return {
    expandedLineageParents: current.expandedLineageParents,
    expandedIdleChildGroups: current.expandedIdleChildGroups,
    compactRootListExpanded: current.compactRootListExpanded,
    toggleLineageParent,
    toggleIdleChildGroup,
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
