import type { TerminalTab } from '../../../../../shared/terminal-tab-types'

type TerminalTabLookup = {
  getTab?: (tabId: string) => { contentType: string; entityId: string } | null
  hasTerminalTab?: (tabId: string) => boolean
}

/** Resolve a renderer tab id to the legacy terminal-tab id used by PTY state. */
export function resolveTerminalTabId(state: TerminalTabLookup, tabId: string): string {
  // The terminal-tab table is authoritative when both id forms are briefly present.
  // A stale unified entry must not redirect a live PTY owner to an older entity id.
  if (state.hasTerminalTab?.(tabId)) {
    return tabId
  }
  const unifiedTab = state.getTab?.(tabId)
  return unifiedTab?.contentType === 'terminal' ? unifiedTab.entityId : tabId
}

// Carry remount/recovery epochs on the same resolved row to avoid a second global tab scan.
type TerminalTabRecord = {
  id: string
  generation?: number
  recovery?: TerminalTab['recovery']
}
type TerminalTabState = {
  getTab?: (
    tabId: string
  ) => ({ contentType: string; entityId: string } & Partial<TerminalTabRecord>) | null
  tabsByWorktree: Record<string, readonly TerminalTabRecord[]>
  getTerminalTabOwnerWorktreeId?: (tabId: string) => string | null | undefined
}

/** Resolve render/entity IDs across one-commit folder/worktree migration gaps; unified tabs store terminal identity under entityId. */
export function findTerminalTabForPane(
  state: TerminalTabState,
  worktreeId: string,
  tabId: string
): TerminalTabRecord | null {
  const unifiedTab = state.getTab?.(tabId)
  const initialOwnerWorktreeId =
    state.getTerminalTabOwnerWorktreeId?.(tabId) ??
    (unifiedTab?.contentType === 'terminal'
      ? state.getTerminalTabOwnerWorktreeId?.(unifiedTab.entityId)
      : null)
  const hasTabIn = (id: string | null | undefined, candidateId: string): boolean =>
    Boolean(id && state.tabsByWorktree[id]?.some((candidate) => candidate.id === candidateId))
  const terminalTabId = resolveTerminalTabId(
    {
      getTab: state.getTab,
      hasTerminalTab: (candidateId) =>
        hasTabIn(worktreeId, candidateId) || hasTabIn(initialOwnerWorktreeId, candidateId)
    },
    tabId
  )
  const ownerWorktreeId =
    state.getTerminalTabOwnerWorktreeId?.(terminalTabId) ?? initialOwnerWorktreeId
  const byId = (id: string | null | undefined): TerminalTabRecord | undefined =>
    id ? state.tabsByWorktree[id]?.find((candidate) => candidate.id === terminalTabId) : undefined
  return (
    byId(worktreeId) ??
    byId(ownerWorktreeId) ??
    Object.values(state.tabsByWorktree)
      .flat()
      .find((candidate) => candidate.id === terminalTabId) ??
    (unifiedTab && 'generation' in unifiedTab
      ? { id: unifiedTab.entityId, generation: unifiedTab.generation }
      : null)
  )
}
