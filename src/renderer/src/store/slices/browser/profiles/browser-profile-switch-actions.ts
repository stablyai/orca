import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from '../browser-slice-contract'

import { findWorkspace } from '../pages/browser-page-records'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import { sendBrowserLayoutCommand } from '../tabs/browser-layout-owner-commands'
import { reconcileBrowserProfileGuests } from './browser-profile-guest-reconciliation'

export function createBrowserProfileSwitchActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<BrowserSlice, 'switchBrowserTabProfile'> {
  return {
    switchBrowserTabProfile: (workspaceId, profileId, sessionPartition) => {
      const switchHere = (): void => {
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
        reconcileBrowserProfileGuests(get, workspaceId)
      }
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
          { here: switchHere, shown: () => reconcileBrowserProfileGuests(get, workspaceId) }
        )
      ) {
        return
      }
      switchHere()
    }
  }
}
