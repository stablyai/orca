import { useState, useSyncExternalStore } from 'react'
import type { AiVaultScope } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { DEFAULT_AI_VAULT_SCOPE } from './ai-vault-scope-state'

import { toggleAiVaultCollapsedGroup } from './ai-vault-view-options-persistence'

type AiVaultPanelTransientState = {
  preferredScope: AiVaultScope
  collapsedGroups: ReadonlySet<string>
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
      update({
        ...snapshot,
        collapsedGroups: toggleAiVaultCollapsedGroup(snapshot.collapsedGroups, key)
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
    toggleGroup: state.toggleGroup
  }
}
