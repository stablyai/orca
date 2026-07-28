import { useAppStore } from '@/store'
import type {
  TerminalTabCloseReason,
  TerminalTabRetirementPlan
} from '@/store/slices/terminal-tab-retirement'

export function closeLocalTerminalTabState(
  terminalTabId: string,
  options?: {
    reason?: TerminalTabCloseReason
    captureRecentlyClosed?: boolean
    remoteCloseOwnedByHost?: boolean
    localPtyTeardownOwnedExternally?: boolean
    precomputedRetirementPlan?: TerminalTabRetirementPlan
    providerTeardownTimeoutMs?: number
    providerTeardownDeadlineMs?: number
    registerProviderTeardown?: (
      teardown: Promise<void>,
      retry: (deadlineMs?: number) => Promise<void>
    ) => void
  }
): void {
  const state = useAppStore.getState()
  if (
    options?.precomputedRetirementPlan?.tabId === terminalTabId ||
    Object.values(state.tabsByWorktree).some((tabs) => tabs.some((tab) => tab.id === terminalTabId))
  ) {
    if (
      options?.reason ||
      options?.captureRecentlyClosed !== undefined ||
      options?.remoteCloseOwnedByHost ||
      options?.localPtyTeardownOwnedExternally ||
      options?.precomputedRetirementPlan ||
      options?.providerTeardownTimeoutMs !== undefined ||
      options?.providerTeardownDeadlineMs !== undefined ||
      options?.registerProviderTeardown
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
