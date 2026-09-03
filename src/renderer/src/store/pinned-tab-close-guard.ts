import { useAppStore } from '@/store'
import { resolveUnifiedTabLabel } from '../../../shared/tab-title-resolution'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
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

/** Whether this terminal tab is the repo's Spotlight server terminal while
 *  Spotlight is active — closing it would kill the dev server and the agent
 *  log mirror, so close attempts must go through the off-and-close prompt. */
export function isSpotlightProtectedTab(
  state: AppState,
  worktreeId: string,
  terminalTabId: string
): boolean {
  const tab = (state.tabsByWorktree?.[worktreeId] ?? []).find((entry) => entry.id === terminalTabId)
  if (!tab?.spotlightRepoRoot) {
    return false
  }
  return Boolean(state.spotlightByRepo?.[getRepoIdFromWorktreeId(worktreeId)])
}

/** Routes a pinned-tab close attempt through the confirmation dialog when the
 *  setting is on. Non-pinned tabs (and pinned tabs when the setting is off)
 *  close immediately. Keeping every close path behind this single helper is why
 *  the keyboard/native-menu paths can no longer silently drop a pinned tab.
 *  When `worktreeId`/`terminalTabId` identify a live Spotlight server terminal,
 *  the close is intercepted regardless of the pinned setting: confirming turns
 *  Spotlight off (restoring the root) before the tab closes. */
export function guardPinnedTabClose(params: {
  isPinned: boolean
  tabLabel: string
  onClose: () => void
  onCancel?: () => void
  worktreeId?: string
  terminalTabId?: string
}): (() => void) | undefined {
  const { isPinned, tabLabel, onClose, onCancel, worktreeId, terminalTabId } = params
  const state = useAppStore.getState()

  if (worktreeId && terminalTabId && isSpotlightProtectedTab(state, worktreeId, terminalTabId)) {
    const request = {
      tabLabel,
      kind: 'spotlight' as const,
      onConfirm: () => {
        const repoId = getRepoIdFromWorktreeId(worktreeId)
        // Close the tab regardless of the deactivate outcome. Closing a
        // terminal is not destructive to git state (the root restore is
        // independent), and gating the close on success made the tab
        // unclosable when restore persistently failed (e.g. a merge in the
        // root). On failure the slice already toasts the reason, and the
        // holder button/context menu can retry the restore.
        void useAppStore
          .getState()
          .deactivateSpotlight(repoId)
          .finally(() => onClose())
      },
      ...(onCancel ? { onCancel } : {})
    }
    state.requestPinnedTabCloseConfirm(request)
    return () => state.cancelPinnedTabCloseRequest(request)
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
