import { useAppStore } from '@/store'
import { resolveUnifiedTabLabel } from '../../../shared/tab-title-resolution'
import { countHostedAgentTabs } from './slices/tabs/agent-cards-teardown'
import type { AppState } from './types'

/** Resolves the displayed tab-strip label for the destructive confirmation. */
export function resolvePinnedTabLabel(
  state: AppState,
  worktreeId: string,
  visibleId: string
): string {
  const tab = (state.unifiedTabsByWorktree?.[worktreeId] ?? []).find(
    (candidate) => candidate.id === visibleId || candidate.entityId === visibleId
  )
  return resolveUnifiedTabLabel(tab, state.settings?.tabAutoGenerateTitle === true)
}

/** Whether the unified tab matching `tabId` (by id or entityId) in the given
 *  worktree is pinned. Used to let pin confirmation take precedence over the
 *  running-process close prompt. */
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

/** Whether a pinned close will actually raise the pin dialog. Callers that let the pin
 *  prompt supersede another confirmation must know this: with the setting off the pin
 *  has nothing to say, so it must not swallow the other prompt (#10142). */
export function shouldConfirmPinnedTabClose(state: AppState): boolean {
  return state.settings?.confirmClosePinnedTab ?? true
}

/** Routes a pinned-tab close attempt through the confirmation dialog when the
 *  setting is on. Non-pinned tabs (and pinned tabs when the setting is off)
 *  close immediately. Keeping every close path behind this single helper is why
 *  the keyboard/native-menu paths can no longer silently drop a pinned tab. */
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
