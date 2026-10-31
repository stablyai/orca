import type { AppState } from '@/store/types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { rawWorkspaceState, workspaceSourceWrite } from '@/store/workspace-source-state'
import { settleBrowserPresentation } from './web-session-tabs-sync/browser-presentation-settlement'
import { peekWebSessionBrowserPlacementGroup } from './web-session-browser-placement'

type FrameStore = {
  getState: () => AppState
  setState: (patch: Partial<AppState>) => void
}

/** Frames admit genuine raw records and settle a pending create's independent placement together. */
export function workspaceLayoutFrameSourceStore(
  store: FrameStore,
  target: RuntimeClientTarget,
  workspaces?: readonly string[]
): FrameStore {
  return {
    getState: () => rawWorkspaceState(store.getState()),
    setState: (patch) => {
      const state = rawWorkspaceState(store.getState())
      if (target.kind === 'environment') {
        const environmentId = target.environmentId
        for (const workspaceId of workspaces ?? []) {
          const placements = (patch.unifiedTabsByWorktree?.[workspaceId] ?? []).flatMap((tab) => {
            if (tab.contentType !== 'browser') {
              return []
            }
            const pages =
              patch.browserPagesByWorkspace?.[tab.entityId] ??
              state.browserPagesByWorkspace[tab.entityId] ??
              []
            const groupId = pages
              .map((page) =>
                peekWebSessionBrowserPlacementGroup({
                  environmentId,
                  worktreeId: workspaceId,
                  remotePageId: page.id
                })
              )
              .find((id) => id !== undefined)
            return groupId ? [{ tabId: tab.id, groupId }] : []
          })
          Object.assign(patch, settleBrowserPresentation(state, patch, workspaceId, placements))
        }
      }
      store.setState(workspaceSourceWrite(patch, { sources: workspaces }))
    }
  }
}
