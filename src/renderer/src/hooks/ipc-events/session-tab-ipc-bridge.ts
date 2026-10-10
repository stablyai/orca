import { isLocalSessionTabCloseOwned } from '@/runtime/local-session-tab-close-owner'
import { closeMobileSessionTabInStore } from '@/runtime/mobile-session-tab-close'
import {
  SESSION_TAB_CLOSE_CANCELED_ERROR,
  SESSION_TAB_CLOSE_FAILED_ERROR,
  SESSION_TAB_NOT_FOUND_ERROR,
  SESSION_TAB_CLOSE_TIMEOUT_ERROR
} from '../../../../shared/session-tab-close'
import {
  guardPinnedTabClose,
  isUnifiedTabPinned,
  resolvePinnedTabLabel
} from '../../store/pinned-tab-close-guard'
import { useAppStore } from '../../store'
import { resolveBrowserSessionTabTarget } from './browser-session-tab-target'
import { resolveWindowTabIdForHostTab } from './host-session-tab-target'

export function registerSessionTabIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onCloseSessionTab(({ tabId, worktreeId }) => {
      if (isLocalSessionTabCloseOwned(worktreeId, tabId)) {
        return
      }
      const localTabId = resolveWindowTabIdForHostTab(worktreeId, tabId)
      const store = useAppStore.getState()
      const browserTarget = resolveBrowserSessionTabTarget(store, worktreeId, localTabId)
      if (browserTarget) {
        guardPinnedTabClose({
          isPinned: isUnifiedTabPinned(store, worktreeId, browserTarget.workspaceId),
          tabLabel: resolvePinnedTabLabel(store, worktreeId, browserTarget.workspaceId),
          onClose: () => useAppStore.getState().closeBrowserTab(browserTarget.workspaceId)
        })
        return
      }
      guardPinnedTabClose({
        isPinned: isUnifiedTabPinned(store, worktreeId, localTabId),
        tabLabel: resolvePinnedTabLabel(store, worktreeId, localTabId),
        onClose: () => {
          const currentStore = useAppStore.getState()
          closeMobileSessionTabInStore(currentStore, worktreeId, localTabId)
        }
      })
    })
  )

  unsubs.push(
    window.api.ui.onSessionTabCloseRequest(({ requestId, tabId, worktreeId, expiresAt }) => {
      const localTabId = resolveWindowTabIdForHostTab(worktreeId, tabId)
      const store = useAppStore.getState()
      const browserTarget = resolveBrowserSessionTabTarget(store, worktreeId, localTabId)
      let cancelConfirmation: (() => void) | undefined
      let timeout: ReturnType<typeof setTimeout> | undefined
      let settled = false
      const respond = (error?: string): void => {
        if (settled) {
          return
        }
        settled = true
        if (timeout !== undefined) {
          clearTimeout(timeout)
        }
        window.api.ui.respondSessionTabClose({ requestId, ...(error ? { error } : {}) })
      }
      if (expiresAt !== undefined) {
        timeout = setTimeout(
          () => {
            cancelConfirmation?.()
            respond(SESSION_TAB_CLOSE_TIMEOUT_ERROR)
          },
          Math.max(0, expiresAt - Date.now())
        )
      }
      const closeAndRespond = (): void => {
        if (expiresAt !== undefined && Date.now() >= expiresAt) {
          respond(SESSION_TAB_CLOSE_TIMEOUT_ERROR)
          return
        }
        try {
          if (browserTarget) {
            useAppStore.getState().closeBrowserTab(browserTarget.workspaceId)
            respond()
            return
          }
          const closed = closeMobileSessionTabInStore(
            useAppStore.getState(),
            worktreeId,
            localTabId
          )
          respond(closed ? undefined : SESSION_TAB_NOT_FOUND_ERROR)
        } catch (error) {
          respond(error instanceof Error ? error.message : SESSION_TAB_CLOSE_FAILED_ERROR)
        }
      }
      if (isLocalSessionTabCloseOwned(worktreeId, tabId)) {
        respond(
          expiresAt !== undefined && Date.now() >= expiresAt
            ? SESSION_TAB_CLOSE_TIMEOUT_ERROR
            : undefined
        )
        return
      }
      const visibleId = browserTarget?.workspaceId ?? localTabId
      cancelConfirmation = guardPinnedTabClose({
        isPinned: isUnifiedTabPinned(store, worktreeId, visibleId),
        tabLabel: resolvePinnedTabLabel(store, worktreeId, visibleId),
        onClose: closeAndRespond,
        onCancel: () => respond(SESSION_TAB_CLOSE_CANCELED_ERROR)
      })
    })
  )

  unsubs.push(
    window.api.ui.onMoveSessionTab((move) => {
      const { tabId, targetGroupId } = move
      const store = useAppStore.getState()
      if (move.kind === 'reorder') {
        store.reorderUnifiedTabs(targetGroupId, move.tabOrder)
        return
      }
      store.dropUnifiedTab(tabId, {
        groupId: targetGroupId,
        ...(move.kind === 'move-to-group' ? { index: move.index } : {}),
        ...(move.kind === 'split' ? { splitDirection: move.splitDirection } : {})
      })
    })
  )
}
