import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from './browser-slice-contract'
import { addAdditionalValidWorkspaceKeys } from '@/lib/workspace-session-hydration-keys'
import { buildValidWorktreeIdsForSessionHydration } from '../../../../../shared/worktree/degraded-repo-worktree-validity'
import { destroyWorkspaceWebviews } from '../browser-webview-cleanup'
import { projectHydratedBrowserSession } from './browser-hydration-state'
import { ensureBrowserClientHostsForRestoredPages } from '@/runtime/restored-client-hosted-browser-host-attach'
import { findWorkspace } from '../browser-page-records'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { sendBrowserLayoutCommand } from './browser-layout-owner-commands'
import { selectFolderWorkspaces } from '../../workspace-record-selectors'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'

export function createBrowserHydrationActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<BrowserSlice, 'hydrateBrowserSession' | 'switchBrowserTabProfile'> {
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
      // Why here and not in the startup chain: the seeded handles are the only record that this
      // desktop was hosting pages, and the runtime only hands them back once it sees an attach.
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
    },

    switchBrowserTabProfile: (workspaceId, profileId, sessionPartition) => {
      const switchHere = (): void =>
        set((s) => {
          for (const [worktreeId, tabs] of Object.entries(s.browserTabsByWorktree)) {
            const tabIndex = tabs.findIndex((t) => t.id === workspaceId)
            if (tabIndex !== -1) {
              const updatedTabs = [...tabs]
              updatedTabs[tabIndex] = {
                ...updatedTabs[tabIndex],
                sessionProfileId: profileId,
                sessionPartition: sessionPartition ?? null
              }
              return {
                browserTabsByWorktree: {
                  ...s.browserTabsByWorktree,
                  [worktreeId]: updatedTabs
                }
              }
            }
          }
          return s
        })
      // Switch point: main switches the tab's profile; its frame shows the change.
      const tab = ORCA_LAYOUT_OWNER_IS_MAIN
        ? findWorkspace(get().browserTabsByWorktree, workspaceId)
        : null
      if (
        tab &&
        sendBrowserLayoutCommand(
          get,
          tab.worktreeId,
          {
            type: 'setBrowserTabProfile',
            browserTabId: workspaceId,
            profileId,
            sessionPartition: sessionPartition ?? null
          },
          { here: switchHere }
        )
      ) {
        return
      }
      switchHere()
    }
  }
}
