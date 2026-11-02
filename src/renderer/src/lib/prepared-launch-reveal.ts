import type { PreparedLaunchSetupTab } from '../../../shared/prepared-agent-launch'
import type { RuntimeNewTerminalTabPlacement } from '../../../shared/runtime-types'
import { placeCreatedTerminalTab } from './unified-tab-anchor-insertion'

// Setup tabs of accepted launches still waiting for their agent, by tab id → workspace. Only a copy of
// main's list: main sends every change, and a loaded or reloaded window asks for it once.
let setupTabWorkspaces = new Map<string, string>()

function adoptPreparedLaunchSetups(tabs: PreparedLaunchSetupTab[]): void {
  setupTabWorkspaces = new Map(tabs.map((tab) => [tab.tabId, tab.worktreeId]))
}

export function registerPreparedLaunchSetupSync(unsubs: (() => void)[]): void {
  const { onPreparedLaunchSetups, getPreparedLaunchSetups } = window.api.ui
  let changed = false
  if (onPreparedLaunchSetups) {
    unsubs.push(
      onPreparedLaunchSetups((tabs) => {
        changed = true
        adoptPreparedLaunchSetups(tabs)
      })
    )
  }
  // A change that lands first is newer than this answer.
  void getPreparedLaunchSetups?.().then((tabs) => {
    if (!changed) {
      adoptPreparedLaunchSetups(tabs)
    }
  })
}

/** Only the tab a prepared agent's reveal made takes the launch's initial place; an existing one keeps the user's. */
export function applyPreparedLaunchReveal(
  worktreeId: string,
  tabId: string,
  created: boolean,
  newTabPlacement: RuntimeNewTerminalTabPlacement | undefined
): void {
  if (newTabPlacement && created) {
    placeCreatedTerminalTab(worktreeId, tabId, newTabPlacement.afterTabId ?? null)
  }
}

/** Closing an accepted launch's waiting Setup leaves its workspace selected, even when that empties it. */
export function closesPreparedLaunchSetup(tabId: string): boolean {
  return setupTabWorkspaces.delete(tabId)
}

export function holdsPreparedLaunchSetup(worktreeId: string): boolean {
  return [...setupTabWorkspaces.values()].includes(worktreeId)
}
