import { useState, useSyncExternalStore } from 'react'
import type { AiVaultScope } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { DEFAULT_AI_VAULT_SCOPE } from './ai-vault-scope-state'

const MAX_COLLAPSED_GROUPS = 512

type AiVaultPanelTransientState = {
  preferredScope: AiVaultScope
  collapsedGroups: ReadonlySet<string>
}

function toggleCollapsedGroup(current: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(current)
  if (next.has(key)) {
    next.delete(key)
    return next
  }
  next.add(key)
  const oldest = next.values().next().value
  if (next.size > MAX_COLLAPSED_GROUPS && oldest !== undefined) {
    next.delete(oldest)
  }
  return next
}

/** Collapse or expand every key in `keys` at once, within the same cap as a single toggle. */
function setCollapsedGroupKeys(
  current: ReadonlySet<string>,
  keys: readonly string[],
  collapsed: boolean
): ReadonlySet<string> {
  const next = new Set(current)
  for (const key of keys) {
    // Why: re-inserting makes the listed keys the newest, so the cap drops older folds first.
    next.delete(key)
    if (collapsed) {
      next.add(key)
    }
  }
  if (!collapsed) {
    return next
  }
  // Why: a listing longer than the cap must still fold whole.
  const limit = Math.max(MAX_COLLAPSED_GROUPS, keys.length)
  for (const oldest of next) {
    if (next.size <= limit) {
      break
    }
    next.delete(oldest)
  }
  return next
}

function createPanelState() {
  let snapshot: AiVaultPanelTransientState = {
    preferredScope: DEFAULT_AI_VAULT_SCOPE,
    collapsedGroups: new Set()
  }
  const listeners = new Set<() => void>()
  const update = (next: AiVaultPanelTransientState): void => {
    snapshot = next
    for (const listener of listeners) {
      listener()
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    selectScope: (preferredScope: AiVaultScope) => {
      if (snapshot.preferredScope !== preferredScope) {
        update({ ...snapshot, preferredScope })
      }
    },
    toggleGroup: (key: string) =>
      update({ ...snapshot, collapsedGroups: toggleCollapsedGroup(snapshot.collapsedGroups, key) }),
    setGroupsCollapsed: (keys: readonly string[], collapsed: boolean) =>
      update({
        ...snapshot,
        collapsedGroups: setCollapsedGroupKeys(snapshot.collapsedGroups, keys, collapsed)
      })
  }
}

// Sidebar navigation unmounts the panel; its choices last until this renderer reloads.
const sidebarState = createPanelState()

export function useAiVaultPanelTransientState(local = false) {
  const [state] = useState(() => (local ? createPanelState() : sidebarState))
  const snapshot = useSyncExternalStore(state.subscribe, state.getSnapshot)
  return {
    ...snapshot,
    selectScope: state.selectScope,
    toggleGroup: state.toggleGroup,
    setGroupsCollapsed: state.setGroupsCollapsed
  }
}
