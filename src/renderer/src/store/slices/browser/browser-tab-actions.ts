import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'
import {
  FLOATING_TERMINAL_WORKTREE_ID,
  ORCA_BROWSER_BLANK_URL
} from '../../../../../shared/constants'
import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from './browser-slice-contract'
import {
  assertManagedBrowserMaterializationAllowed,
  getClientCreationActionPolicy
} from '@/lib/client-creation-action-policy'
import {
  buildBrowserPage,
  buildWorkspaceFromPage,
  findPage,
  findWorkspace
} from '../browser-page-records'
import { getBrowserSessionProfileHostId } from './browser-host-state'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'

export function createBrowserTabActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<
  BrowserSlice,
  | 'createBrowserTab'
  | 'openNewBrowserTabInActiveWorkspace'
  | 'openBrowserProfileTabInActiveWorkspace'
> {
  return {
    createBrowserTab: (worktreeId, url, options) => {
      assertManagedBrowserMaterializationAllowed(get(), options?.browserRuntimeEnvironmentId)
      const workspaceId = createBrowserUuid()
      const browserPageId = options?.browserPageId
      if (
        browserPageId &&
        (findWorkspace(get().browserTabsByWorktree, browserPageId) ||
          findPage(get().browserPagesByWorkspace, browserPageId))
      ) {
        throw new Error(`Browser page ${browserPageId} already exists`)
      }
      const page = buildBrowserPage(
        workspaceId,
        worktreeId,
        url,
        options?.title,
        options?.browserRuntimeEnvironmentId,
        browserPageId,
        options?.docLocation
      )
      // Why: with no explicit profile, inherit the user's default so a Settings preference applies to new tabs.
      const sessionProfileId =
        options?.sessionProfileId !== undefined
          ? options.sessionProfileId
          : (get().defaultBrowserSessionProfileIdByHostId[
              getBrowserSessionProfileHostId(
                get(),
                worktreeId,
                options?.browserRuntimeEnvironmentId
              )
            ] ?? get().defaultBrowserSessionProfileId)
      const browserTab = buildWorkspaceFromPage(
        workspaceId,
        worktreeId,
        page,
        [page.id],
        sessionProfileId,
        options?.sessionPartition
      )

      set((s) => {
        const existingTabs = s.browserTabsByWorktree[worktreeId] ?? []
        const nextTabBarOrder = (() => {
          const currentOrder = s.tabBarOrderByWorktree[worktreeId] ?? []
          const terminalIds = (s.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
          const editorIds = s.openFiles
            .filter((file) => file.worktreeId === worktreeId)
            .map((file) => file.id)
          const browserIds = existingTabs.map((tab) => tab.id)
          const allExistingIds = new Set([...terminalIds, ...editorIds, ...browserIds])
          const base = currentOrder.filter((entryId) => allExistingIds.has(entryId))
          const inBase = new Set(base)
          for (const entryId of [...terminalIds, ...editorIds, ...browserIds]) {
            if (!inBase.has(entryId)) {
              base.push(entryId)
              inBase.add(entryId)
            }
          }
          base.push(workspaceId)
          return base
        })()

        const shouldActivate = options?.activate ?? true
        const shouldUpdateGlobalActiveSurface = shouldActivate && s.activeWorktreeId === worktreeId
        const shouldFocusFloatingTab =
          shouldActivate && worktreeId === FLOATING_TERMINAL_WORKTREE_ID
        const shouldFocusAddressBar =
          (shouldUpdateGlobalActiveSurface || shouldFocusFloatingTab) &&
          // Why the doc check and not just the url: a document page is blank by construction, and
          // the blank url is exactly what marks a New Tab as wanting the address bar it does not have.
          !page.docLocation &&
          (options?.focusAddressBar ??
            (page.url === 'about:blank' || page.url === ORCA_BROWSER_BLANK_URL))

        return {
          browserTabsByWorktree: {
            ...s.browserTabsByWorktree,
            [worktreeId]: [...existingTabs, browserTab]
          },
          browserPagesByWorkspace: {
            ...s.browserPagesByWorkspace,
            [workspaceId]: [page]
          },
          tabBarOrderByWorktree: {
            ...s.tabBarOrderByWorktree,
            [worktreeId]: nextTabBarOrder
          },
          activeBrowserTabId: shouldUpdateGlobalActiveSurface ? workspaceId : s.activeBrowserTabId,
          activeBrowserTabIdByWorktree: {
            ...s.activeBrowserTabIdByWorktree,
            [worktreeId]: shouldActivate
              ? workspaceId
              : (s.activeBrowserTabIdByWorktree[worktreeId] ?? null)
          },
          activeTabType: shouldUpdateGlobalActiveSurface ? 'browser' : s.activeTabType,
          activeTabTypeByWorktree: shouldActivate
            ? { ...s.activeTabTypeByWorktree, [worktreeId]: 'browser' }
            : s.activeTabTypeByWorktree,
          pendingAddressBarFocusByPageId: shouldFocusAddressBar
            ? {
                ...s.pendingAddressBarFocusByPageId,
                [page.id]: true
              }
            : s.pendingAddressBarFocusByPageId,
          pendingAddressBarFocusByTabId: shouldFocusAddressBar
            ? {
                ...s.pendingAddressBarFocusByTabId,
                [workspaceId]: true,
                [page.id]: true
              }
            : s.pendingAddressBarFocusByTabId
        }
      })

      const state = get()
      const alreadyHasUnifiedTab = (state.unifiedTabsByWorktree[worktreeId] ?? []).some(
        (t) => t.contentType === 'browser' && t.entityId === workspaceId
      )
      if (!alreadyHasUnifiedTab) {
        state.createUnifiedTab(worktreeId, 'browser', {
          entityId: workspaceId,
          label: browserTab.title,
          targetGroupId: options?.targetGroupId,
          activate: options?.activate ?? true
        })
      }
      return browserTab
    },

    openNewBrowserTabInActiveWorkspace: async (groupId) => {
      const state = get()
      const worktreeId = state.activeWorktreeId
      if (!worktreeId) {
        return
      }
      const browserAvailability = getClientCreationActionPolicy(state, worktreeId)[
        'managed-browser'
      ]
      if (browserAvailability.state !== 'enabled') {
        throw new Error(browserAvailability.reason)
      }
      const defaultUrl = state.browserDefaultUrl ?? 'about:blank'
      const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
      if (browserAvailability.provider === 'paired-runtime') {
        if (!runtimeEnvironmentId) {
          throw new Error('The paired runtime browser provider is unavailable.')
        }
        const { createWebRuntimeSessionBrowserTab } = await import('@/runtime/web-runtime-session')
        try {
          const created = await createWebRuntimeSessionBrowserTab({
            worktreeId,
            environmentId: runtimeEnvironmentId,
            url: defaultUrl,
            // Why: desktop pane groups are client-owned — the local reconciler only honors a
            // recorded clientTargetGroupId; targetGroupId steers snapshot-driven clients instead.
            targetGroupId: groupId,
            clientTargetGroupId: groupId
          })
          if (created) {
            get().recordFeatureInteraction('browser-tab-created')
            return
          }
        } catch (error) {
          // Why: browser.headless.v1 remotes succeed above, so a failure here is real; surface it instead of a confusing local-tab fallback (split ownership).
          console.warn(
            '[browser] remote browser tab creation failed:',
            error instanceof Error ? error.message : String(error)
          )
          throw error
        }
        throw new Error('The paired runtime could not create a managed browser tab.')
      }
      get().createBrowserTab(worktreeId, defaultUrl, {
        title: translate('auto.store.slices.browser.d175274b6d', 'New Browser Tab'),
        focusAddressBar: true,
        ...(runtimeEnvironmentId ? { browserRuntimeEnvironmentId: null } : {}),
        targetGroupId: groupId
      })
      get().recordFeatureInteraction('browser-tab-created')
    },

    openBrowserProfileTabInActiveWorkspace: async (url, profileId) => {
      const state = get()
      const worktreeId = state.activeWorktreeId
      if (!worktreeId) {
        return false
      }
      const browserAvailability = getClientCreationActionPolicy(state, worktreeId)[
        'managed-browser'
      ]
      if (browserAvailability.state !== 'enabled') {
        return false
      }
      const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
      if (browserAvailability.provider === 'paired-runtime') {
        if (!runtimeEnvironmentId) {
          return false
        }
        const { createWebRuntimeSessionBrowserTab } = await import('@/runtime/web-runtime-session')
        try {
          return await createWebRuntimeSessionBrowserTab({
            worktreeId,
            environmentId: runtimeEnvironmentId,
            url,
            profileId
          })
        } catch (error) {
          console.warn(
            '[browser] remote profile tab creation failed:',
            error instanceof Error ? error.message : String(error)
          )
          return false
        }
      }
      get().createBrowserTab(worktreeId, url, {
        activate: true,
        sessionProfileId: profileId,
        ...(runtimeEnvironmentId ? { browserRuntimeEnvironmentId: null } : {})
      })
      return true
    }
  }
}
