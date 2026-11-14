import { useCallback, useSyncExternalStore } from 'react'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  composeWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../../../../../../shared/worktree/host-qualified-identity'

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
const expansionByKey = new Map<HostScopedWorktreeKey, WorktreeAgentExpansionState>()

/**
 * Local and remote copies of a workspace share its id, so disclosure is keyed per host. Unstamped
 * rows default to local, the same default the card's title status and slot targets use.
 */
function expansionKey(
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined
): HostScopedWorktreeKey {
  return composeWorktreeHostIdentity(executionHostId ?? 'local', worktreeId)
}

function trimPersistedExpansions(): void {
  while (expansionByKey.size > MAX_PERSISTED_WORKTREE_AGENT_EXPANSIONS) {
    const oldest = expansionByKey.keys().next().value
    if (oldest === undefined) {
      break
    }
    expansionByKey.delete(oldest)
    notifyExpansion(oldest)
  }
}

function readExpansionState(key: HostScopedWorktreeKey): WorktreeAgentExpansionState {
  return expansionByKey.get(key) ?? DEFAULT_EXPANSION_STATE
}

function persistExpansionState(
  key: HostScopedWorktreeKey,
  state: WorktreeAgentExpansionState
): void {
  // Refresh LRU order and retain only non-default disclosures.
  expansionByKey.delete(key)
  if (
    state.compactRootListExpanded ||
    state.expandedLineageParents.size > 0 ||
    state.expandedIdleChildGroups.size > 0
  ) {
    expansionByKey.set(key, state)
    trimPersistedExpansions()
  }
}

const expansionListeners = new Map<HostScopedWorktreeKey, Set<() => void>>()

/** Unfold a card's agent list from outside the card, e.g. when a rolled-up slot opens one of its agents. */
export function expandWorktreeAgentList(
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined
): void {
  const key = expansionKey(worktreeId, executionHostId)
  const base = readExpansionState(key)
  if (base.compactRootListExpanded) {
    return
  }
  persistExpansionState(key, { ...base, compactRootListExpanded: true })
  notifyExpansion(key)
}

function notifyExpansion(key: HostScopedWorktreeKey): void {
  for (const listener of expansionListeners.get(key) ?? []) {
    listener()
  }
}

function subscribeExpansion(key: HostScopedWorktreeKey, listener: () => void): () => void {
  let listeners = expansionListeners.get(key)
  if (!listeners) {
    listeners = new Set()
    expansionListeners.set(key, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      expansionListeners.delete(key)
    }
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
export function useWorktreeAgentExpansionState(
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined
): WorktreeAgentExpansionControls {
  const key = expansionKey(worktreeId, executionHostId)
  const subscribe = useCallback((listener: () => void) => subscribeExpansion(key, listener), [key])
  const getSnapshot = useCallback(() => readExpansionState(key), [key])
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const commit = useCallback(
    (next: WorktreeAgentExpansionState) => {
      persistExpansionState(key, next)
      notifyExpansion(key)
    },
    [key]
  )

  const toggleLineageParent = useCallback(
    (paneKey: string) => {
      const base = readExpansionState(key)
      commit({ ...base, expandedLineageParents: toggleKey(base.expandedLineageParents, paneKey) })
    },
    [commit, key]
  )

  const toggleIdleChildGroup = useCallback(
    (parentPaneKey: string) => {
      const base = readExpansionState(key)
      commit({
        ...base,
        expandedIdleChildGroups: toggleKey(base.expandedIdleChildGroups, parentPaneKey)
      })
    },
    [commit, key]
  )

  const toggleCompactRootList = useCallback(() => {
    const base = readExpansionState(key)
    commit({ ...base, compactRootListExpanded: !base.compactRootListExpanded })
  }, [commit, key])

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
  expansionByKey.clear()
}

export function seedWorktreeAgentExpansionStateForTests(
  worktreeId: string,
  state: WorktreeAgentExpansionState,
  executionHostId?: ExecutionHostId
): void {
  persistExpansionState(expansionKey(worktreeId, executionHostId), state)
}
