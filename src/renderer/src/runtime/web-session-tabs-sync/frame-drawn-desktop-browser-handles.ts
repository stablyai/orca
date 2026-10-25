import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { markWebSessionBrowserPlacementAdopted } from '../web-session-browser-placement'
import { findBrowserWorkspaceForRemotePage } from './mirrored-browser-tabs'
import type { WebSessionTabsBatchContext, WebSessionTabsSyncState } from './state'
import { writableWebSessionTabsRecord } from './state-equality-core'
import { isReadyBrowserTab } from './terminal-surfaces'

/**
 * In a frame-drawn workspace the frames own every tab, but a page this desktop hosts never enters
 * the server's layout: the server's snapshot listing it is the proof its create landed. So only the
 * handle of a staged client-hosted page is adopted here, as the mirror would (L282).
 */
export function adoptFrameDrawnClientHostedBrowserHandles(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  worktreeId: string,
  batchContext?: WebSessionTabsBatchContext
): Partial<WebSessionTabsSyncState> {
  let handles = state.remoteBrowserPageHandlesByPageId
  for (const tab of snapshot.tabs) {
    if (!isReadyBrowserTab(tab) || tab.placement?.kind !== 'client') {
      continue
    }
    const existing = findBrowserWorkspaceForRemotePage(
      state,
      worktreeId,
      environmentId,
      tab.browserPageId
    )
    if (!existing || handles[existing.page.id]?.staged !== true) {
      continue
    }
    if (handles === state.remoteBrowserPageHandlesByPageId) {
      handles = writableWebSessionTabsRecord(
        state,
        'remoteBrowserPageHandlesByPageId',
        batchContext
      )
    }
    handles[existing.page.id] = {
      environmentId,
      remotePageId: tab.browserPageId,
      placement: tab.placement
    }
    markWebSessionBrowserPlacementAdopted({
      environmentId,
      worktreeId,
      remotePageId: tab.browserPageId
    })
  }
  return handles === state.remoteBrowserPageHandlesByPageId
    ? {}
    : { remoteBrowserPageHandlesByPageId: handles }
}
