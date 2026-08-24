import { redactKagiSessionToken } from '../../../shared/browser-url'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

export function buildBrowserSessionData(
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>,
  browserPagesByWorkspace: Record<string, BrowserPage[]>,
  activeBrowserTabIdByWorktree: Record<string, string | null>
): Pick<
  WorkspaceSessionState,
  'browserTabsByWorktree' | 'browserPagesByWorkspace' | 'activeBrowserTabIdByWorktree'
> {
  // Why: guest WebContents are recreated on restore, so persist only redacted chrome state and reset transient loading.
  return {
    browserTabsByWorktree: buildPersistedBrowserTabsByWorktree(browserTabsByWorktree),
    browserPagesByWorkspace: buildPersistedBrowserPagesByWorkspace(browserPagesByWorkspace),
    activeBrowserTabIdByWorktree
  }
}

export function buildPersistedBrowserTabsByWorktree(
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>
): WorkspaceSessionState['browserTabsByWorktree'] {
  return Object.fromEntries(
    Object.entries(browserTabsByWorktree).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.map((tab) => ({
        ...tab,
        url: redactKagiSessionToken(tab.url),
        title: redactKagiSessionToken(tab.title),
        loading: false
      }))
    ])
  )
}

export function buildPersistedBrowserPagesByWorkspace(
  browserPagesByWorkspace: Record<string, BrowserPage[]>
): WorkspaceSessionState['browserPagesByWorkspace'] {
  return Object.fromEntries(
    Object.entries(browserPagesByWorkspace).map(([workspaceId, pages]) => [
      workspaceId,
      pages.map((page) => ({
        ...page,
        url: redactKagiSessionToken(page.url),
        title: redactKagiSessionToken(page.title),
        loading: false
      }))
    ])
  )
}
