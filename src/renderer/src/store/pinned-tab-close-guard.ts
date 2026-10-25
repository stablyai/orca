import { useAppStore } from '@/store'
import { resolveUnifiedTabLabel } from '../../../shared/tab-title-resolution'
import type { AppState } from './types'

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

/** Centralize pin confirmation across keyboard/native/menu paths; unpinned or disabled-confirmation closes proceed immediately. */
export function guardPinnedTabClose(params: {
  isPinned: boolean
  tabLabel: string
  onClose: () => void
  onCancel?: () => void
}): (() => void) | undefined {
  const { isPinned, tabLabel, onClose, onCancel } = params
  if (!isPinned) {
    onClose()
    return undefined
  }

  const state = useAppStore.getState()
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
