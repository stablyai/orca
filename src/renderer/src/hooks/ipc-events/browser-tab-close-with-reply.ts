import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { hasUnsentBrowserNotes } from '@/store/slices/browser/annotations/browser-page-annotation'
import {
  guardPinnedTabClose,
  isUnifiedTabPinned,
  resolvePinnedTabLabel
} from '../../store/slices/tabs/closing/pinned-tab-close-guard'

/** Closes a browser tab, or one page of it, for a CLI or extension request once the user allows it, then replies to main. */
export function closeBrowserTabWithReply(params: {
  requestId: string
  worktreeId: string
  workspaceId: string
  /** Closes only this page, so the tab's pin does not guard it; its notes do. */
  pageId?: string
}): void {
  const { requestId, worktreeId, workspaceId, pageId } = params
  const state = useAppStore.getState()
  const unsentNotes = pageId
    ? (state.browserAnnotationsByPageId[pageId]?.length ?? 0) > 0
    : hasUnsentBrowserNotes(state, workspaceId)
  const closedId = pageId ?? workspaceId
  guardPinnedTabClose({
    isPinned: !pageId && isUnifiedTabPinned(state, worktreeId, workspaceId),
    tabLabel: resolvePinnedTabLabel(state, worktreeId, workspaceId),
    onClose: () => {
      const latest = useAppStore.getState()
      // Siblings may have closed while the prompt was open; the last page closes its tab.
      if (pageId && (latest.browserPagesByWorkspace[workspaceId]?.length ?? 0) > 1) {
        latest.closeBrowserPage(pageId)
      } else {
        latest.closeBrowserTab(workspaceId)
      }
      window.api.ui.replyTabClose({ requestId })
    },
    onCancel: () =>
      window.api.ui.replyTabClose({
        requestId,
        error: unsentNotes
          ? translate(
              'auto.hooks.useIpcEvents.unsent_notes_close_canceled',
              'Browser tab {{value0}} has unsent notes, and the user kept it open',
              { value0: closedId }
            )
          : translate('auto.hooks.useIpcEvents.2f6637fe6c', 'Browser tab {{value0}} is pinned', {
              value0: closedId
            })
      }),
    unsentNotes
  })
}
