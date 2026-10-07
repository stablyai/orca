import type { Tab } from '../../../../shared/tab-types'

/** Resolves the unified tab a per-tab presentation action (rename, color) targets.
 *  Terminal tabs are addressed by their backing terminal's entityId; a structured
 *  chat has no TerminalTab record and is addressed by the unified tab id itself. */
export function findRenamableUnifiedTab(
  unifiedTabsByWorktree: Record<string, Tab[]>,
  tabId: string
): Tab | undefined {
  const unified = Object.values(unifiedTabsByWorktree).flat()
  return (
    unified.find((entry) => entry.contentType === 'terminal' && entry.entityId === tabId) ??
    unified.find((entry) => entry.contentType === 'agent-session' && entry.id === tabId)
  )
}
