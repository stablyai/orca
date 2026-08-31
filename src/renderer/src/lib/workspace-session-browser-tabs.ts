import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { RemoteBrowserPageHandle } from '../store/slices/browser'

export function buildBrowserSessionData(
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>,
  browserPagesByWorkspace: Record<string, BrowserPage[]>,
  activeBrowserTabIdByWorktree: Record<string, string | null>,
  remoteBrowserPageHandlesByPageId: Record<string, RemoteBrowserPageHandle>
): Pick<
  WorkspaceSessionState,
  'browserTabsByWorktree' | 'browserPagesByWorkspace' | 'activeBrowserTabIdByWorktree'
> {
  return {
    // Why: guest webContents are recreated on restore, so persist only lightweight chrome state (loading reset to false).
    browserTabsByWorktree: buildPersistedBrowserTabsByWorktree(browserTabsByWorktree),
    browserPagesByWorkspace: buildPersistedBrowserPagesByWorkspace(
      browserPagesByWorkspace,
      remoteBrowserPageHandlesByPageId
    ),
    activeBrowserTabIdByWorktree
  }
}

export function buildPersistedBrowserTabsByWorktree(
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>
): WorkspaceSessionState['browserTabsByWorktree'] {
  return Object.fromEntries(
    Object.entries(browserTabsByWorktree).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.map((tab) => ({ ...tab, loading: false }))
    ])
  )
}

export function buildPersistedBrowserPagesByWorkspace(
  browserPagesByWorkspace: Record<string, BrowserPage[]>,
  remoteBrowserPageHandlesByPageId: Record<string, RemoteBrowserPageHandle>
): WorkspaceSessionState['browserPagesByWorkspace'] {
  return Object.fromEntries(
    Object.entries(browserPagesByWorkspace).map(([workspaceId, pages]) => [
      workspaceId,
      pages.map((page) => ({
        ...page,
        loading: false,
        ...persistedRemoteBrowserPageIdentity(remoteBrowserPageHandlesByPageId[page.id])
      }))
    ])
  )
}

/** The half of the remote page handle a relaunch can rebuild from: which host page this row is,
 *  and whether this desktop was hosting it. Restored rows carry the marker before the host has
 *  republished a placement, so a second quit must read it from there too. */
function persistedRemoteBrowserPageIdentity(
  handle: RemoteBrowserPageHandle | undefined
): Pick<BrowserPage, 'remoteBrowserPageId' | 'remoteBrowserPageClientHosted'> {
  if (!handle) {
    return {}
  }
  const clientHosted = handle.placement?.kind === 'client' || handle.restoredClientHosted === true
  return {
    remoteBrowserPageId: handle.remotePageId,
    ...(clientHosted ? { remoteBrowserPageClientHosted: true } : {})
  }
}
