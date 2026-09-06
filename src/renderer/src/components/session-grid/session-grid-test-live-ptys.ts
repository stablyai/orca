import type { TerminalTab } from '../../../../shared/terminal-tab-types'

// Why: the grid only previews a pty listed in `ptyIdsByTabId` (the liveness truth), so a seeded tab needs its pty registered there to render a card.
export function livePtyIdsFor(
  tabsByWorktree: Record<string, TerminalTab[]>
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const tabs of Object.values(tabsByWorktree)) {
    for (const tab of tabs) {
      out[tab.id] = tab.ptyId ? [tab.ptyId] : []
    }
  }
  return out
}
