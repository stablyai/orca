import { closeMobileSessionTabInStore } from '@/runtime/mobile-session-tab-close'
import {
  SESSION_TAB_CLOSE_CANCELED_ERROR,
  SESSION_TAB_CLOSE_FAILED_ERROR,
  SESSION_TAB_NOT_FOUND_ERROR,
  SESSION_TAB_CLOSE_TIMEOUT_ERROR
} from '../../../../shared/session-tab-close'
import {
  guardTabClose,
  isUnifiedTabPinned,
  resolveTabLabel
} from '../../store/tab-close-guard'
import { useAppStore } from '../../store'
import { resolveBrowserSessionTabTarget } from './browser-session-tab-target'

export function registerSessionTabIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onCloseSessionTab(({ tabId, worktreeId }) => {
      const store = useAppStore.getState()
      const browserTarget = resolveBrowserSessionTabTarget(store, worktreeId, tabId)
      if (browserTarget) {
        guardTabClose({
          isPinned: isUnifiedTabPinned(store, worktreeId, browserTarget.workspaceId),
          tabLabel: resolveTabLabel(store, worktreeId, browserTarget.workspaceId),
          onClose: () => useAppStore.getState().closeBrowserTab(browserTarget.workspaceId)
        })
        return
      }
      guardTabClose({
        isPinned: isUnifiedTabPinned(store, worktreeId, tabId),
        tabLabel: resolveTabLabel(store, worktreeId, tabId),
        onClose: () => {
          const currentStore = useAppStore.getState()
          closeMobileSessionTabInStore(currentStore, worktreeId, tabId)
        }
      })
    })
  )

  unsubs.push(
    window.api.ui.onSessionTabCloseRequest(({ requestId, tabId, worktreeId, expiresAt }) => {
      const store = useAppStore.getState()
      const browserTarget = resolveBrowserSessionTabTarget(store, worktreeId, tabId)
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
          const closed = closeMobileSessionTabInStore(useAppStore.getState(), worktreeId, tabId)
          respond(closed ? undefined : SESSION_TAB_NOT_FOUND_ERROR)
        } catch (error) {
          respond(error instanceof Error ? error.message : SESSION_TAB_CLOSE_FAILED_ERROR)
        }
      }
      const visibleId = browserTarget?.workspaceId ?? tabId
      cancelConfirmation = guardTabClose({
        isPinned: isUnifiedTabPinned(store, worktreeId, visibleId),
        tabLabel: resolveTabLabel(store, worktreeId, visibleId),
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
