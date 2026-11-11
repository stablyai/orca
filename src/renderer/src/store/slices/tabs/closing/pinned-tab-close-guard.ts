import { useAppStore } from '@/store'
import { resolveUnifiedTabLabel } from '../../../../../../shared/tab-title-resolution'
import { readStructuredChatTabName } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import type { AppState } from '../../../types'

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

/** Only enabled pin prompts may supersede process confirmation; disabled pin settings must not swallow other warnings (#10142). */
export function shouldConfirmPinnedTabClose(state: AppState): boolean {
  return state.settings?.confirmClosePinnedTab ?? true
}

/** Centralize close confirmation across keyboard/native/menu/CLI paths: unsent browser notes always ask; pins ask unless turned off. */
export function guardPinnedTabClose(params: {
  isPinned: boolean
  tabLabel: string
  onClose: () => void
  onCancel?: () => void
  /** The tab holds browser notes the user has not sent; closing discards them. */
  unsentNotes?: boolean
}): (() => void) | undefined {
  const { isPinned, tabLabel, onClose, onCancel, unsentNotes } = params
  const state = useAppStore.getState()
  if (!unsentNotes && (!isPinned || !shouldConfirmPinnedTabClose(state))) {
    onClose()
    return undefined
  }

  const request = {
    tabLabel,
    onConfirm: onClose,
    ...(onCancel ? { onCancel } : {}),
    ...(unsentNotes ? { unsentNotes: true as const } : {})
  }
  state.requestPinnedTabCloseConfirm(request)
  return () => state.cancelPinnedTabCloseRequest(request)
}
