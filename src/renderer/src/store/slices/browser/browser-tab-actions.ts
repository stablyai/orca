import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'
import type {
  BrowserSlice,
  BrowserSliceGet,
  BrowserSliceSet,
  CreateBrowserTabOptions
} from './browser-slice-contract'
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
import { resolveNewBrowserTabProfile } from './browser-new-tab-profile'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { admitBrowserPageMount } from '@/components/browser-pane/host-guest/browser-page-mount-admission'
import {
  getRegisteredPairedBrowserTabCreator,
  loadPairedBrowserTabCreator
} from './paired-browser-tab-creator'
import { findGroupAndWorktree } from '../tab-group-state'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { openBrowserTabThroughLayoutOwner } from './browser-tab-open-through-layout-owner'
import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import {
  FLOATING_TERMINAL_WORKTREE_ID,
  ORCA_BROWSER_BLANK_URL
} from '../../../../../shared/constants'
import type { AppState } from '../../types'
import { ownsGlobalSelection } from '../../global-selection-owner'

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
      if (!options?.browserRuntimeEnvironmentId && !options?.docLocation) {
        admitBrowserPageMount(page.id)
      }
      // Why: with no explicit profile, Settings decides, so the profile scope applies to every way a tab opens.
      const { sessionProfileId, sessionPartition } =
        options?.sessionProfileId !== undefined
          ? options
          : resolveNewBrowserTabProfile(
              get(),
              worktreeId,
              getBrowserSessionProfileHostId(
                get(),
                worktreeId,
                options?.browserRuntimeEnvironmentId
              )
            )
      const browserTab = buildWorkspaceFromPage(
        workspaceId,
        worktreeId,
        page,
        [page.id],
        sessionProfileId,
        sessionPartition
      )

      const drawHere = (): void => {
        set((s) => ({
          browserTabsByWorktree: {
            ...s.browserTabsByWorktree,
            [worktreeId]: [...(s.browserTabsByWorktree[worktreeId] ?? []), browserTab]
          },
          browserPagesByWorkspace: {
            ...s.browserPagesByWorkspace,
            [workspaceId]: [page]
          },
          ...browserTabOpenView(s, worktreeId, browserTab, page, options)
        }))

        const state = get()
        const alreadyHasUnifiedTab = (state.unifiedTabsByWorktree[worktreeId] ?? []).some(
          (t) => t.contentType === 'browser' && t.entityId === workspaceId
        )
        if (!alreadyHasUnifiedTab) {
          const shouldActivate = options?.activate ?? true
          const created = state.createUnifiedTab(worktreeId, 'browser', {
            entityId: workspaceId,
            label: browserTab.title,
            targetGroupId: options?.targetGroupId,
            ...(options?.split ? { split: options.split } : {}),
            ...(options?.afterTabId ? { afterTabId: options.afterTabId } : {}),
            // Why no routing-host default: a substituted host would disown the wrapper from its worktree.
            ...(options?.executionHostId ? { executionHostId: options.executionHostId } : {}),
            activate: shouldActivate
          })
          // Why: unified creation already selected the tab and recorded the visit; only the group moves.
          if (shouldActivate && created) {
            get().focusGroup(worktreeId, created.groupId)
          }
        }
      }
      // Switch point: main opens the tab under these ids and its frame draws it.
      if (
        ORCA_LAYOUT_OWNER_IS_MAIN &&
        openBrowserTabThroughLayoutOwner(get, {
          worktreeId,
          browserTab,
          page,
          options,
          showView: () => set((s) => browserTabOpenView(s, worktreeId, browserTab, page, options)),
          drawHere
        })
      ) {
        return browserTab
      }
      drawHere()
      return browserTab
    },

    openNewBrowserTabInActiveWorkspace: async (groupId) => {
      const state = get()
      // Why: the invoking group owns its workspace; global selection may already point elsewhere.
      const worktreeId =
        findGroupAndWorktree(state.groupsByWorktree, groupId)?.worktreeId ?? state.activeWorktreeId
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
      const runtimeEnvironmentId = runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
      if (browserAvailability.provider === 'paired-runtime') {
        if (!runtimeEnvironmentId) {
          throw new Error('The paired runtime browser provider is unavailable.')
        }
        // The registered path stages on the click; a cold runtime loads before staging.
        const createPairedBrowserTab =
          getRegisteredPairedBrowserTabCreator() ?? (await loadPairedBrowserTabCreator())
        try {
          const created = await createPairedBrowserTab({
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
        browserRuntimeEnvironmentId: null,
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
      const runtimeEnvironmentId = runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
      if (browserAvailability.provider === 'paired-runtime') {
        if (!runtimeEnvironmentId) {
          return false
        }
        const createPairedBrowserTab =
          getRegisteredPairedBrowserTabCreator() ?? (await loadPairedBrowserTabCreator())
        try {
          return await createPairedBrowserTab({
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
        browserRuntimeEnvironmentId: null
      })
      return true
    }
  }
}

// The window's own view of a browser tab it opens: its tab-bar order entry, browser selection and
// the address-bar focus a blank New Tab asks for; a layout-owner build writes it once drawn.
function browserTabOpenView(
  s: AppState,
  worktreeId: string,
  browserTab: BrowserWorkspace,
  page: BrowserPage,
  options: CreateBrowserTabOptions | undefined
): Partial<AppState> {
  const workspaceId = browserTab.id
  // Without this tab: a frame may already have drawn its record.
  const existingTabs = (s.browserTabsByWorktree[worktreeId] ?? []).filter(
    (tab) => tab.id !== workspaceId
  )
  const nextTabBarOrder = (() => {
    const currentOrder = s.tabBarOrderByWorktree[worktreeId] ?? []
    const terminalIds = (s.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
    const editorIds = s.openFiles
      .filter((file) => file.worktreeId === worktreeId)
      .map((file) => file.id)
    const ids = [...terminalIds, ...editorIds, ...existingTabs.map((tab) => tab.id)]
    const allExistingIds = new Set(ids)
    const base = currentOrder.filter((entryId) => allExistingIds.has(entryId))
    const inBase = new Set(base)
    return [...base, ...[...allExistingIds].filter((entryId) => !inBase.has(entryId)), workspaceId]
  })()

  const shouldActivate = options?.activate ?? true
  const shouldUpdateGlobalActiveSurface = shouldActivate && ownsGlobalSelection(s, worktreeId)
  const shouldFocusFloatingTab = shouldActivate && worktreeId === FLOATING_TERMINAL_WORKTREE_ID
  const shouldFocusAddressBar =
    (shouldUpdateGlobalActiveSurface || shouldFocusFloatingTab) &&
    // Why the doc check and not just the url: a document page is blank by construction, and
    // the blank url is exactly what marks a New Tab as wanting the address bar it does not have.
    !page.docLocation &&
    (options?.focusAddressBar ??
      (page.url === 'about:blank' || page.url === ORCA_BROWSER_BLANK_URL))

  return {
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
}
