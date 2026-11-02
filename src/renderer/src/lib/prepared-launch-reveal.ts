import type { RuntimeNewTerminalTabPlacement } from '../../../shared/runtime-types'
import { placeCreatedTerminalTab } from './unified-tab-anchor-insertion'

// Setup tabs of accepted agent launches whose agent has not been shown yet, by tab id → workspace.
// Session memory only: a restarted window learns them again when main republishes Setup.
const setupTabWorkspaces = new Map<string, string>()

/** What a prepared launch's reveal asks of the tab it shows. */
export function applyPreparedLaunchReveal(
  worktreeId: string,
  tabId: string,
  created: boolean,
  reveal: { newTabPlacement?: RuntimeNewTerminalTabPlacement; preparedLaunchSetup?: true }
): void {
  if (reveal.preparedLaunchSetup) {
    setupTabWorkspaces.set(tabId, worktreeId)
  }
  if (!reveal.newTabPlacement) {
    return
  }
  // The agent arrived, so its workspace no longer waits on Setup.
  for (const [setupTabId, workspace] of setupTabWorkspaces) {
    if (workspace === worktreeId) {
      setupTabWorkspaces.delete(setupTabId)
    }
  }
  // Only the tab this reveal made takes the launch's initial place; an existing one keeps the user's.
  if (created) {
    placeCreatedTerminalTab(worktreeId, tabId, reveal.newTabPlacement.afterTabId ?? null)
  }
}

/** Closing an accepted launch's Setup leaves its workspace selected, even when that empties it. */
export function closesPreparedLaunchSetup(tabId: string): boolean {
  return setupTabWorkspaces.delete(tabId)
}

export function holdsPreparedLaunchSetup(worktreeId: string): boolean {
  return [...setupTabWorkspaces.values()].includes(worktreeId)
}
