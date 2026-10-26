import { useAppStore } from '@/store'
import { resolveUnifiedTabLabel } from '../../../shared/tab-title-resolution'
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

/** Only enabled pin prompts may supersede process confirmation; disabled pin settings must not swallow other warnings (#10142). */
export function shouldConfirmPinnedTabClose(state: AppState): boolean {
  return state.settings?.confirmClosePinnedTab ?? true
}

/** Centralize pin confirmation across keyboard/native/menu paths; unpinned or disabled-confirmation closes proceed immediately. */
export function guardPinnedTabClose(params: {
  signal?: AbortSignal
  isPinned: boolean
  tabLabel: string
  onClose: () => void
  onCancel?: () => void
}): (() => void) | undefined {
  const { isPinned, tabLabel, onClose, onCancel } = params
  if (params.signal?.aborted) {
    onCancel?.()
    return
  }
  if (!isPinned) {
    onClose()
    return undefined
  }

  const state = useAppStore.getState()
  if (!shouldConfirmPinnedTabClose(state)) {
    onClose()
    return undefined
  }

  const dispose = () => params.signal?.removeEventListener('abort', cancel)
  const cancel = () => {
    dispose()
    state.cancelPinnedTabCloseRequest(request)
    onCancel?.()
  }
  const request = {
    tabLabel,
    onConfirm: params.signal
      ? () => {
          dispose()
          onClose()
        }
      : onClose,
    ...(onCancel || params.signal
      ? {
          onCancel: params.signal
            ? () => {
                dispose()
                onCancel?.()
              }
            : onCancel
        }
      : {})
  }
  state.requestPinnedTabCloseConfirm(request)
  params.signal?.addEventListener('abort', cancel, { once: true })
  return cancel
}
