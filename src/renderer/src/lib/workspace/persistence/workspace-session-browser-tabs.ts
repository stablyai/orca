import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import type { BrowserPageAnnotation } from '../../../../../shared/browser/element-grab/browser-grab-types'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import type { RemoteBrowserPageHandle } from '../../../store/slices/browser/browser-slice-contract'

export function buildBrowserSessionData(
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>,
  browserPagesByWorkspace: Record<string, BrowserPage[]>,
  activeBrowserTabIdByWorktree: Record<string, string | null>,
  remoteBrowserPageHandlesByPageId: Record<string, RemoteBrowserPageHandle>,
  browserAnnotationsByPageId: Record<string, BrowserPageAnnotation[]>
): Pick<
  WorkspaceSessionState,
  'browserTabsByWorktree' | 'browserPagesByWorkspace' | 'activeBrowserTabIdByWorktree'
> {
  return {
    // Why: guest webContents are recreated on restore, so persist only lightweight chrome state (loading reset to false).
    browserTabsByWorktree: buildPersistedBrowserTabsByWorktree(browserTabsByWorktree),
    browserPagesByWorkspace: buildPersistedBrowserPagesByWorkspace(
      browserPagesByWorkspace,
      remoteBrowserPageHandlesByPageId,
      browserAnnotationsByPageId
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
  remoteBrowserPageHandlesByPageId: Record<string, RemoteBrowserPageHandle>,
  browserAnnotationsByPageId: Record<string, BrowserPageAnnotation[]>
): WorkspaceSessionState['browserPagesByWorkspace'] {
  return Object.fromEntries(
    Object.entries(browserPagesByWorkspace).map(([workspaceId, pages]) => [
      workspaceId,
      pages.map((page) => {
        const annotations = browserAnnotationsByPageId[page.id]
        return {
          ...page,
          loading: false,
          ...persistedRemoteBrowserPageIdentity(remoteBrowserPageHandlesByPageId[page.id]),
          ...(annotations?.length ? { annotations } : {})
        }
      })
    ])
  )
}

// Persist host page identity/client-hosted status before republished placement arrives; restored markers must survive a second quit too.
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
