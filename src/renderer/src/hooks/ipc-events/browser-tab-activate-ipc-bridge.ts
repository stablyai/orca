import { translate } from '@/i18n/i18n'
import { activateBrowserWorkspaceTab } from '@/lib/browser-workspace-tab-activation'
import { useAppStore } from '../../store'
import {
  findBrowserTabWorktreeId,
  isBrowserWorkspaceOwnedByPairedServer
} from './browser-request-workspace-owner'

/**
 * Main asks to make a browser page the active tab (an extension's tabs.update({active: true})).
 * It activates within the page's own worktree and never switches the worktree the user is in.
 */
export function registerBrowserTabActivateIpcBridge(unsubs: (() => void)[]): void {
  const subscribe = window.api.browser?.onRequestTabActivate
  if (!subscribe) {
    return
  }
  unsubs.push(
    subscribe(({ requestId, browserPageId }) => {
      const store = useAppStore.getState()
      const worktreeId = findBrowserTabWorktreeId(store, browserPageId)
      const workspaceId = Object.entries(store.browserPagesByWorkspace).find(([, pages]) =>
        pages.some((page) => page.id === browserPageId)
      )?.[0]
      const activated =
        worktreeId !== null &&
        workspaceId !== undefined &&
        !isBrowserWorkspaceOwnedByPairedServer(store, worktreeId) &&
        activateBrowserWorkspaceTab({ worktreeId, workspaceId, pageId: browserPageId })
      window.api.browser.replyTabActivate(
        activated
          ? { requestId }
          : {
              requestId,
              error: translate(
                'auto.hooks.useIpcEvents.0e3cf53060',
                'Browser tab {{value0}} not found',
                { value0: browserPageId }
              )
            }
      )
    })
  )
}
