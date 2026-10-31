import { useAppStore } from '@/store'
import { resolveUnifiedTabLabel } from '../../../shared/tab-title-resolution'
import { countHostedAgentTabs } from './slices/tabs/agent-cards-teardown'
import { readStructuredChatTabName } from '@/runtime/structured-chat-tab-name'
import type { AppState } from './types'

export function resolvePinnedTabLabel(
  state: AppState,
  worktreeId: string,
  visibleId: string
): string {
  const tab = (state.unifiedTabsByWorktree?.[worktreeId] ?? []).find(
    (candidate) => candidate.id === visibleId || candidate.entityId === visibleId
  )
  return tab?.contentType === 'agent-session'
    ? readStructuredChatTabName(tab, state)
    : resolveUnifiedTabLabel(tab, state.settings?.tabAutoGenerateTitle === true)
}

/** Check unified id/entityId pin state before running-process confirmation. */
export function isUnifiedTabPinned(state: AppState, worktreeId: string, tabId: string): boolean {
  return (state.unifiedTabsByWorktree?.[worktreeId] ?? []).some(
    (tab) => (tab.id === tabId || tab.entityId === tabId) && tab.isPinned === true
  )
}

/**
 * The Agents tab close, when `tabId` names it and it still hosts agents.
 *
 * Why the Agents tab is special: it is only a host for the agents carded inside it, so closing
 * it alone is undone by the reconciler a frame later and reads as nothing happening. Confirming
 * closes the agents themselves, which is the only outcome the action can honestly offer.
 */
export function resolveAgentsTabClose(
  state: AppState,
  worktreeId: string,
  tabId: string
): { agentCount: number } | null {
  const tabs = state.unifiedTabsByWorktree?.[worktreeId] ?? []
  const tab = tabs.find((candidate) => candidate.id === tabId || candidate.entityId === tabId)
  if (tab?.contentType !== 'agents') {
    return null
  }
  // Why the shared hosted selector: overflow agents past the card cap stay ordinary tabs, so
  // counting every agent would overstate the prompt and closing them would end sessions the
  // user never saw inside this tab.
  const agentCount = countHostedAgentTabs(state, worktreeId)
  // With no agents left the reconciler is already retiring the tab, so the ordinary path applies.
  return agentCount > 0 ? { agentCount } : null
}

/** Only enabled pin prompts may supersede process confirmation; disabled pin settings must not swallow other warnings (#10142). */
export function shouldConfirmPinnedTabClose(state: AppState): boolean {
  return state.settings?.confirmClosePinnedTab ?? true
}

/** Centralize pin confirmation across keyboard/native/menu paths; unpinned or disabled-confirmation closes proceed immediately. */
export function guardPinnedTabClose(params: {
  isPinned: boolean
  tabLabel: string
  onClose: () => void
  onCancel?: () => void
  /** Supply both to let the Agents tab raise its own prompt about the agents it hosts. */
  worktreeId?: string
  tabId?: string
}): (() => void) | undefined {
  const { isPinned, tabLabel, onClose, onCancel, worktreeId, tabId } = params
  const state = useAppStore.getState()
  const agentsClose =
    worktreeId !== undefined && tabId !== undefined
      ? resolveAgentsTabClose(state, worktreeId, tabId)
      : null

  if (agentsClose && worktreeId !== undefined) {
    // Why this ignores `confirmClosePinnedTab`: that setting answers "this tab is pinned",
    // which is not the question here. Closing this tab ends live agent sessions, so it is
    // confirmed every time rather than behind a preference about pinned tabs.
    const agentsRequest = {
      tabLabel,
      agentCount: agentsClose.agentCount,
      onConfirm: () => {
        useAppStore.getState().closeAllAgentCards(worktreeId)
      },
      ...(onCancel ? { onCancel } : {})
    }
    state.requestPinnedTabCloseConfirm(agentsRequest)
    return () => state.cancelPinnedTabCloseRequest(agentsRequest)
  }

  if (!isPinned) {
    onClose()
    return undefined
  }

  if (!shouldConfirmPinnedTabClose(state)) {
    onClose()
    return undefined
  }

  const request = {
    tabLabel,
    onConfirm: onClose,
    ...(onCancel ? { onCancel } : {})
  }
  state.requestPinnedTabCloseConfirm(request)
  return () => state.cancelPinnedTabCloseRequest(request)
}
