import { destroyPersistentWebview } from '@/components/browser-pane/host-guest/webview-registry'
import {
  guardPinnedTabClose,
  isUnifiedTabPinned,
  resolvePinnedTabLabel
} from '../../store/pinned-tab-close-guard'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { acquireBrowserAutomationBootstrapLease } from './browser-automation-bootstrap-lease'

export function registerBrowserRequestIpcBridge(
  unsubs: (() => void)[],
  isRuntimeEnvironmentActive: () => boolean
): void {
  unsubs.push(
    window.api.ui.onRequestTabCreate((data) => {
      try {
        if (isRuntimeEnvironmentActive()) {
          // Why: browser automation targets client-local Electron webviews that runtime agents can't see or control.
          window.api.ui.replyTabCreate({
            requestId: data.requestId,
            error: translate(
              'auto.hooks.useIpcEvents.291c8ed902',
              'Browser tabs are unavailable while a remote runtime is active'
            )
          })
          return
        }
        const store = useAppStore.getState()
        const worktreeId = data.worktreeId ?? store.activeWorktreeId
        if (!worktreeId) {
          window.api.ui.replyTabCreate({
            requestId: data.requestId,
            error: translate('auto.hooks.useIpcEvents.f000b2ff76', 'No active worktree')
          })
          return
        }
        // Why: CLI-created tabs should land in the active browser tab's group, not the terminal's UI-active group.
        const activeBrowserTabId = store.activeBrowserTabIdByWorktree[worktreeId]
        const activeBrowserUnifiedTab = activeBrowserTabId
          ? (store.unifiedTabsByWorktree[worktreeId] ?? []).find(
              (t) => t.contentType === 'browser' && t.entityId === activeBrowserTabId
            )
          : undefined

        // Why: a user-initiated open (data.activate, e.g. mobile tapping an HTML path) foregrounds the tab so it lands in active-group order and publishes to mobile.
        // Agent/automation opens stay in the background (activate:false) in the active browser group.
        const workspace = store.createBrowserTab(worktreeId, data.url, {
          title: data.url,
          browserPageId: data.browserPageId,
          targetGroupId: data.activate ? undefined : activeBrowserUnifiedTab?.groupId,
          sessionProfileId: data.sessionProfileId,
          sessionPartition: data.sessionPartition,
          activate: data.activate === true
        })
        // Why: registerGuest fires with the page ID, not the workspace ID; return it so waitForTabRegistration can correlate.
        const pages = useAppStore.getState().browserPagesByWorkspace[workspace.id] ?? []
        const browserPageId = pages[0]?.id ?? workspace.id
        acquireBrowserAutomationBootstrapLease(worktreeId, browserPageId)
        window.api.ui.replyTabCreate({ requestId: data.requestId, browserPageId })
      } catch (err) {
        window.api.ui.replyTabCreate({
          requestId: data.requestId,
          error: err instanceof Error ? err.message : 'Tab creation failed'
        })
      }
    })
  )

  unsubs.push(
    window.api.ui.onRequestTabSetProfile((data) => {
      try {
        if (isRuntimeEnvironmentActive()) {
          window.api.ui.replyTabSetProfile({
            requestId: data.requestId,
            error: translate(
              'auto.hooks.useIpcEvents.f45fa2b03c',
              'Browser profiles are unavailable while a remote runtime is active'
            )
          })
          return
        }
        const store = useAppStore.getState()
        const owningWorkspace = Object.values(store.browserTabsByWorktree)
          .flat()
          .find((workspace) => {
            if (workspace.id === data.browserPageId) {
              return true
            }
            const pages = store.browserPagesByWorkspace[workspace.id] ?? []
            return pages.some((page) => page.id === data.browserPageId)
          })
        if (!owningWorkspace) {
          window.api.ui.replyTabSetProfile({
            requestId: data.requestId,
            error: translate(
              'auto.hooks.useIpcEvents.0e3cf53060',
              'Browser tab {{value0}} not found',
              { value0: data.browserPageId }
            )
          })
          return
        }
        // Why: a workspace may host several browser pages; profile switch must tear down all sibling webviews, not just the IPC's.
        const workspacePages = store.browserPagesByWorkspace[owningWorkspace.id] ?? []
        if (workspacePages.length > 0) {
          for (const page of workspacePages) {
            destroyPersistentWebview(page.id)
          }
        } else {
          destroyPersistentWebview(data.browserPageId)
        }
        store.switchBrowserTabProfile(owningWorkspace.id, data.profileId, data.sessionPartition)
        window.api.ui.replyTabSetProfile({ requestId: data.requestId })
      } catch (err) {
        window.api.ui.replyTabSetProfile({
          requestId: data.requestId,
          error: err instanceof Error ? err.message : 'Tab profile update failed'
        })
      }
    })
  )

  unsubs.push(
    window.api.ui.onRequestTabClose((data) => {
      try {
        if (isRuntimeEnvironmentActive()) {
          window.api.ui.replyTabClose({
            requestId: data.requestId,
            error: translate(
              'auto.hooks.useIpcEvents.291c8ed902',
              'Browser tabs are unavailable while a remote runtime is active'
            )
          })
          return
        }
        const store = useAppStore.getState()
        const explicitTargetId = data.tabId ?? null
        const replyBrowserTabNotFound = (tabId: string): void => {
          window.api.ui.replyTabClose({
            requestId: data.requestId,
            code: 'browser_tab_not_found',
            error: translate(
              'auto.hooks.useIpcEvents.0e3cf53060',
              'Browser tab {{value0}} not found',
              { value0: tabId }
            )
          })
        }
        const replyPinnedBrowserCloseCanceled = (tabId: string): void => {
          window.api.ui.replyTabClose({
            requestId: data.requestId,
            error: translate(
              'auto.hooks.useIpcEvents.2f6637fe6c',
              'Browser tab {{value0}} is pinned',
              { value0: tabId }
            )
          })
        }
        const closeBrowserWorkspaceWithReply = (worktreeId: string, workspaceId: string): void => {
          const currentStore = useAppStore.getState()
          guardPinnedTabClose({
            isPinned: isUnifiedTabPinned(currentStore, worktreeId, workspaceId),
            tabLabel: resolvePinnedTabLabel(currentStore, worktreeId, workspaceId),
            onClose: () => {
              useAppStore.getState().closeBrowserTab(workspaceId)
              window.api.ui.replyTabClose({ requestId: data.requestId })
            },
            onCancel: () => replyPinnedBrowserCloseCanceled(workspaceId)
          })
        }
        const tabToClose =
          explicitTargetId ??
          (data.worktreeId
            ? (store.activeBrowserTabIdByWorktree?.[data.worktreeId] ?? null)
            : store.activeBrowserTabId)
        if (!tabToClose) {
          window.api.ui.replyTabClose({
            requestId: data.requestId,
            error: translate('auto.hooks.useIpcEvents.a8d2bf8e9e', 'No active browser tab to close')
          })
          return
        }
        // Why: the bridge keys tabs by browserPageId, but closeBrowserTab expects a workspace id.
        // Per the CLI's `tab close --page` contract, close only that page unless it is the last in its workspace.
        const isWorkspaceId = Object.values(store.browserTabsByWorktree)
          .flat()
          .some((ws) => ws.id === tabToClose)
        if (!isWorkspaceId) {
          const owningWorkspace = Object.entries(store.browserPagesByWorkspace).find(([, pages]) =>
            pages.some((p) => p.id === tabToClose)
          )
          if (owningWorkspace) {
            const [workspaceId, pages] = owningWorkspace
            const owningWorktreeId =
              Object.entries(store.browserTabsByWorktree).find(([, tabs]) =>
                tabs.some((tab) => tab.id === workspaceId)
              )?.[0] ?? null
            if (data.worktreeId && owningWorktreeId !== data.worktreeId) {
              replyBrowserTabNotFound(tabToClose)
              return
            }
            if (pages.length <= 1) {
              if (owningWorktreeId) {
                closeBrowserWorkspaceWithReply(owningWorktreeId, workspaceId)
                return
              }
              store.closeBrowserTab(workspaceId)
            } else {
              store.closeBrowserPage(tabToClose)
            }
            window.api.ui.replyTabClose({ requestId: data.requestId })
            return
          }
        }
        const owningWorktreeId =
          Object.entries(store.browserTabsByWorktree).find(([, tabs]) =>
            tabs.some((tab) => tab.id === tabToClose)
          )?.[0] ?? null
        if (owningWorktreeId) {
          if (data.worktreeId && owningWorktreeId !== data.worktreeId) {
            replyBrowserTabNotFound(tabToClose)
            return
          }
          closeBrowserWorkspaceWithReply(owningWorktreeId, tabToClose)
          return
        }
        if (explicitTargetId) {
          replyBrowserTabNotFound(explicitTargetId)
          return
        }
        store.closeBrowserTab(tabToClose)
        window.api.ui.replyTabClose({ requestId: data.requestId })
      } catch (err) {
        window.api.ui.replyTabClose({
          requestId: data.requestId,
          error: err instanceof Error ? err.message : 'Tab close failed'
        })
      }
    })
  )
}
