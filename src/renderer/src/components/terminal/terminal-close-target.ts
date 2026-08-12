import type { AppState } from '@/store'
import type { TerminalTabRetirementPlan } from '@/store/slices/terminal-tab-retirement'

export type PrecomputedTerminalCloseState = {
  owningWorktreeId: string
  terminalCountBeforeClose: number
  nextTerminalTabId: string | null
}

export type TerminalCloseTarget = {
  worktreeId: string
  terminalTabId: string
}

export function validatePrecomputedTerminalCloseState(
  tabId: string,
  retirementPlan: TerminalTabRetirementPlan | undefined,
  closeState: PrecomputedTerminalCloseState | undefined
): PrecomputedTerminalCloseState | undefined {
  return retirementPlan?.tabId === tabId &&
    retirementPlan.worktreeId === closeState?.owningWorktreeId
    ? closeState
    : undefined
}

export function resolveTerminalCloseTarget(
  state: Pick<AppState, 'tabsByWorktree' | 'unifiedTabsByWorktree'>,
  tabId: string,
  precomputed: PrecomputedTerminalCloseState | undefined
): TerminalCloseTarget | null {
  if (precomputed) {
    return { worktreeId: precomputed.owningWorktreeId, terminalTabId: tabId }
  }
  for (const [worktreeId, worktreeTabs] of Object.entries(state.tabsByWorktree)) {
    if (worktreeTabs.some((tab) => tab.id === tabId)) {
      return { worktreeId, terminalTabId: tabId }
    }
  }
  for (const [worktreeId, unifiedTabs] of Object.entries(state.unifiedTabsByWorktree ?? {})) {
    const unified = unifiedTabs.find(
      (tab) => tab.contentType === 'terminal' && (tab.entityId === tabId || tab.id === tabId)
    )
    if (unified) {
      return { worktreeId, terminalTabId: unified.entityId }
    }
  }
  return null
}

// Why: host-backed terminals may exist only in unified state, so sibling
// selection must merge both representations into one terminal entity set.
export function getWorktreeTerminalTabIds(
  state: Pick<AppState, 'tabsByWorktree' | 'unifiedTabsByWorktree'>,
  worktreeId: string
): string[] {
  const ids = new Set<string>()
  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    ids.add(tab.id)
  }
  for (const tab of state.unifiedTabsByWorktree?.[worktreeId] ?? []) {
    if (tab.contentType === 'terminal') {
      ids.add(tab.entityId)
    }
  }
  return [...ids]
}
