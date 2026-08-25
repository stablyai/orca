import { useAppStore } from '@/store'
import { resolveUnifiedTabLabel } from '../../../shared/tab-title-resolution'
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
