import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from '../browser-slice-contract'
import { addAdditionalValidWorkspaceKeys } from '@/lib/workspace/persistence/workspace-session-hydration-keys'
import { buildValidWorktreeIdsForSessionHydration } from '../../../../../../shared/worktree/degraded-repo-worktree-validity'
import { destroyWorkspaceWebviews } from '../cleanup/browser-webview-cleanup'
import { projectHydratedBrowserSession } from './browser-hydration-state'
import { ensureBrowserClientHostsForRestoredPages } from '@/runtime/browser/client-hosting/restored-client-hosted-browser-host-attach'

import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'

import { selectFolderWorkspaces } from '../../../workspaces/catalog/workspace-record-fields'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'

export function createBrowserHydrationActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<BrowserSlice, 'hydrateBrowserSession'> {
  return {
    hydrateBrowserSession: (session, options) => {
      const persistedTabsByWorktree = session.browserTabsByWorktree ?? {}
      const currentState = get()
      const validWorktreeIdsForCleanup = buildValidWorktreeIdsForSessionHydration(
        currentState,
        Object.keys(persistedTabsByWorktree)
      )
      validWorktreeIdsForCleanup.add(FLOATING_TERMINAL_WORKTREE_ID)
      for (const workspace of selectFolderWorkspaces(currentState)) {
        validWorktreeIdsForCleanup.add(folderWorkspaceKey(workspace.id))
      }
      addAdditionalValidWorkspaceKeys(validWorktreeIdsForCleanup, options)

      // Why: destroy dropped workspaces' webviews before the pure reducer; no-op today (boot registry empty), defends future re-hydration callers.
      const droppedWorkspaceIds: string[] = []
      for (const [worktreeId, tabs] of Object.entries(persistedTabsByWorktree)) {
        if (!validWorktreeIdsForCleanup.has(worktreeId)) {
          for (const tab of tabs) {
            droppedWorkspaceIds.push(tab.id)
          }
        }
      }
      for (const workspaceId of droppedWorkspaceIds) {
        destroyWorkspaceWebviews(currentState.browserPagesByWorkspace, workspaceId)
      }

      set((s) => {
        const validWorktreeIds = buildValidWorktreeIdsForSessionHydration(
          s,
          Object.keys(persistedTabsByWorktree)
        )
        validWorktreeIds.add(FLOATING_TERMINAL_WORKTREE_ID)
        for (const workspace of selectFolderWorkspaces(s)) {
          validWorktreeIds.add(folderWorkspaceKey(workspace.id))
        }
        addAdditionalValidWorkspaceKeys(validWorktreeIds, options)
        return projectHydratedBrowserSession(s, session, validWorktreeIds)
      })

      const state = get()
      // Seeded handles alone prove prior desktop hosting; attach is required for runtime to hand those pages back.
      void ensureBrowserClientHostsForRestoredPages(state)
      for (const [worktreeId, browserTabs] of Object.entries(state.browserTabsByWorktree)) {
        // Switch point: main's layout load gives a tabless record its tab; its frame draws it.
        if (ORCA_LAYOUT_OWNER_IS_MAIN && !runtimeEnvironmentIdUnlessTwin(state, worktreeId)) {
          continue
        }
        for (const bt of browserTabs) {
          const exists = (state.unifiedTabsByWorktree[worktreeId] ?? []).some(
            (t) => t.contentType === 'browser' && t.entityId === bt.id
          )
          if (!exists) {
            state.createUnifiedTab(worktreeId, 'browser', {
              entityId: bt.id,
              label: bt.title,
              recordInteraction: false
            })
          }
        }
      }
    }
  }
}
