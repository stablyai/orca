import { useAppStore } from '@/store'
import { resolveUnifiedTabLabel } from '../../../shared/tab-title-resolution'
import type { AppState } from './types'

/** Resolves the displayed tab-strip label for the destructive confirmation. */
export function resolveTabLabel(state: AppState, worktreeId: string, visibleId: string): string {
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

/** Routes a tab close attempt through the confirmation dialog when a matching
 *  setting is on. Pinned tabs confirm via `confirmClosePinnedTab` (default on).
 *  Any tab confirms via the opt-in `confirmCloseAnyTab`, but only when the close
 *  is a genuine local user gesture (`userInitiated`) — remote/CLI/lifecycle
 *  closes must not raise a local modal. Pinned takes precedence so its dedicated
 *  copy wins. When neither applies the tab closes immediately. Keeping every
 *  close path behind this single helper is why the keyboard/native-menu paths
 *  can no longer silently drop a guarded tab. */
export function guardTabClose(params: {
  isPinned: boolean
  tabLabel: string
  /** True for local ✕ / context-menu Close / Cmd+W gestures. Defaults false so
   *  IPC/CLI/lifecycle callers only ever hit the pinned confirmation. */
  userInitiated?: boolean
  onClose: () => void
  onCancel?: () => void
}): (() => void) | undefined {
  const { isPinned, tabLabel, userInitiated = false, onClose, onCancel } = params
  const state = useAppStore.getState()
  const confirmPinned = state.settings?.confirmClosePinnedTab ?? true
  const confirmAny = userInitiated && (state.settings?.confirmCloseAnyTab ?? false)

  const cancel = onCancel ? { onCancel } : {}
  if (isPinned && confirmPinned) {
    const request = {
      tabLabel,
      variant: 'pinned' as const,
      onConfirm: onClose,
      ...cancel
    }
    state.requestPinnedTabCloseConfirm(request)
    return () => state.cancelPinnedTabCloseRequest(request)
  }
  if (confirmAny) {
    const request = {
      tabLabel,
      variant: 'any' as const,
      onConfirm: onClose,
      ...cancel
    }
    state.requestPinnedTabCloseConfirm(request)
    return () => state.cancelPinnedTabCloseRequest(request)
  }
  onClose()
  return undefined
}
