import { destroyPersistentWebview } from '@/components/browser-pane/host-guest/webview-registry'
import {
  guardPinnedTabClose,
  isUnifiedTabPinned,
  resolvePinnedTabLabel
} from '../../store/pinned-tab-close-guard'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { acquireBrowserAutomationBootstrapLease } from './browser-automation-bootstrap-lease'
import { browserTabSplitTarget, splitCallerWorktreeId } from './browser-tab-split-placement'
import {
  findBrowserTabWorktreeId,
  isBrowserWorkspaceOwnedByPairedServer,
  isDesktopRenderedBrowserTab,
  resolveRemoteCliBrowserWorkspace
} from './browser-request-workspace-owner'

function pairedServerWorkspaceError(): string {
  return translate(
    'browser.request.pairedServerWorkspace',
    "This workspace runs on a paired server. Use that server's browser tabs."
  )
}

// Why after restore: main holds extension tab requests until a restored workspace can take them.
// Register after registerBrowserRequestIpcBridge, whose listener takes those requests.
export function signalBrowserTabRequestsReadyAfterRestore(unsubs: (() => void)[]): void {
  if (useAppStore.getState().workspaceSessionReady) {
    window.api.ui.browserTabRequestsReady?.()
    return
  }
  const unsubscribe = useAppStore.subscribe((state) => {
    if (state.workspaceSessionReady) {
      unsubscribe()
      window.api.ui.browserTabRequestsReady?.()
    }
  })
  unsubs.push(unsubscribe)
}

// Route by proven workspace owner, not Active Server; this desktop’s runtime requests its own pages regardless of focus (#22275).
export function registerBrowserRequestIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onRequestRemoteCliBrowserScope((data) => {
      let workspaceId: string | null = null
      try {
        workspaceId = resolveRemoteCliBrowserWorkspace(useAppStore.getState(), data)
      } catch {
        // Why: an owner this window cannot prove is a refusal, never a pass.
        workspaceId = null
      }
      window.api.ui.replyRemoteCliBrowserScope({ requestId: data.requestId, workspaceId })
    })
  )
  unsubs.push(
    window.api.ui.onRequestTabCreate((data) => {
      try {
        const store = useAppStore.getState()
        // Why the fallback last: an extension's tab goes where its profile was last used only when
        // nothing is active, and only to a workspace this window still knows.
        const fallbackWorktreeId =
          data.fallbackWorktreeId && store.getKnownWorktreeById(data.fallbackWorktreeId)
            ? data.fallbackWorktreeId
            : null
        const worktreeId =
          data.worktreeId ??
          (data.split ? splitCallerWorktreeId(store, data.splitFromTabId) : undefined) ??
          store.activeWorktreeId ??
          fallbackWorktreeId
        if (!worktreeId) {
          window.api.ui.replyTabCreate({
            requestId: data.requestId,
            error: translate('auto.hooks.useIpcEvents.f000b2ff76', 'No active worktree')
          })
          return
        }
        // Why only the fallback: main resolved an explicit id against its own catalog already.
        if (!data.worktreeId && isBrowserWorkspaceOwnedByPairedServer(store, worktreeId)) {
          window.api.ui.replyTabCreate({
            requestId: data.requestId,
            error: pairedServerWorkspaceError()
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

        // Foreground explicit user opens; agent/automation/paired-device background opens stay in the browser group without moving this host’s view.
        const workspace = store.createBrowserTab(worktreeId, data.url, {
          title: data.url,
          browserPageId: data.browserPageId,
          ...(data.split
            ? { split: browserTabSplitTarget(store, worktreeId, data.split, data.splitFromTabId) }
            : { targetGroupId: data.activate ? undefined : activeBrowserUnifiedTab?.groupId }),
          sessionProfileId: data.sessionProfileId,
          sessionPartition: data.sessionPartition,
          // This runtime asks for desktop-rendered pages, including managed-SSH workspaces; explicit null prevents streaming another host’s page.
          browserRuntimeEnvironmentId: null,
          activate: data.activate === true
        })
        // Why: registerGuest fires with the page ID, not the workspace ID; return it so waitForTabRegistration can correlate.
        const pages = useAppStore.getState().browserPagesByWorkspace[workspace.id] ?? []
        // A layout-owner build draws the page once main's frame lands: answer the id it was opened under.
        const browserPageId =
          data.browserPageId ?? pages[0]?.id ?? workspace.activePageId ?? workspace.id
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
        const store = useAppStore.getState()
        const pageWorktreeId = findBrowserTabWorktreeId(store, data.browserPageId)
        if (pageWorktreeId && isBrowserWorkspaceOwnedByPairedServer(store, pageWorktreeId)) {
          window.api.ui.replyTabSetProfile({
            requestId: data.requestId,
            error: pairedServerWorkspaceError()
          })
          return
        }
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
        // Profile changes must tear down every sibling webview in the workspace.
        const workspacePages = store.browserPagesByWorkspace[owningWorkspace.id] ?? []
        if (workspacePages.length > 0) {
          for (const page of workspacePages) {
            // Document previews use a fixed partition, so profile changes must preserve their guests.
            if (!page.docLocation) {
              destroyPersistentWebview(page.id)
            }
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
        const closeWorktreeId = findBrowserTabWorktreeId(store, tabToClose)
        if (
          closeWorktreeId &&
          isBrowserWorkspaceOwnedByPairedServer(store, closeWorktreeId) &&
          !isDesktopRenderedBrowserTab(store, tabToClose)
        ) {
          window.api.ui.replyTabClose({
            requestId: data.requestId,
            error: pairedServerWorkspaceError()
          })
          return
        }
        // Resolve page IDs to workspace IDs for closeBrowserTab; page-close closes the workspace only for its last page.
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
