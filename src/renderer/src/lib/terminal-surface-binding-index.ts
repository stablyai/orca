import type { TerminalTab } from '../../../shared/terminal-tab-types'

/** Derived only for one synchronous census; the staged store remains the binding authority. */
export function indexTerminalSurfaceBindings(store: {
  tabsByWorktree: Record<string, TerminalTab[]>
  ptyIdsByTabId: Record<string, string[]>
}) {
  const owners = new Map<string, { ownerWorktreeId: string; tab: TerminalTab }[]>()
  const ptyOwners = new Map<string, Set<string>>()
  const noteBinding = (tabId: string, ptyId: string): void => {
    const held = ptyOwners.get(ptyId) ?? new Set<string>()
    held.add(tabId)
    ptyOwners.set(ptyId, held)
  }
  for (const [ownerWorktreeId, tabs] of Object.entries(store.tabsByWorktree)) {
    for (const tab of tabs) {
      const tabId = tab.id
      const held = owners.get(tabId) ?? []
      held.push({ ownerWorktreeId, tab })
      owners.set(tabId, held)
    }
  }
  for (const [tabId, ptyIds] of Object.entries(store.ptyIdsByTabId)) {
    for (const ptyId of ptyIds) {
      noteBinding(tabId, ptyId)
    }
  }
  const removeMissingOwners = (
    worktreeId: string,
    previous: TerminalTab[],
    current: TerminalTab[]
  ): void => {
    const present = new Set(current.map((tab) => tab.id))
    for (const tab of previous) {
      if (!present.has(tab.id)) {
        const remaining = (owners.get(tab.id) ?? []).filter(
          (owner) => owner.ownerWorktreeId !== worktreeId
        )
        owners.set(tab.id, remaining)
      }
    }
  }
  return { owners, ptyOwners, noteBinding, removeMissingOwners }
}
