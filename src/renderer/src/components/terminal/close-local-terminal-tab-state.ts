import { useAppStore } from '@/store'
import type {
  TerminalTabCloseReason,
  TerminalTabRetirementPlan
} from '@/store/slices/terminal-tab-retirement'

export function closeLocalTerminalTabState(
  terminalTabId: string,
  options?: {
    reason?: TerminalTabCloseReason
    remoteCloseOwnedByHost?: boolean
    localPtyTeardownOwnedExternally?: boolean
    precomputedRetirementPlan?: TerminalTabRetirementPlan
  }
): void {
  const state = useAppStore.getState()
  if (
    options?.precomputedRetirementPlan?.tabId === terminalTabId ||
    Object.values(state.tabsByWorktree).some((tabs) => tabs.some((tab) => tab.id === terminalTabId))
  ) {
    if (
      options?.reason ||
      options?.remoteCloseOwnedByHost ||
      options?.localPtyTeardownOwnedExternally ||
      options?.precomputedRetirementPlan
    ) {
      state.closeTab(terminalTabId, options)
    } else {
      state.closeTab(terminalTabId)
    }
    return
  }

  for (const tabs of Object.values(state.unifiedTabsByWorktree ?? {})) {
    const unified = tabs.find(
      (tab) =>
        tab.contentType === 'terminal' &&
        (tab.entityId === terminalTabId || tab.id === terminalTabId)
    )
    if (unified) {
      state.closeTab(unified.entityId, options)
      return
    }
  }
}
