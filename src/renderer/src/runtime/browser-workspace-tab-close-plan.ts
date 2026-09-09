import type { AppState } from '@/store/types'
import { getBrowserWorkspaceRemoteOwnerEnvironmentIds } from './remote-browser-tab-ownership'

type BrowserWorkspaceTabCloseState = Pick<
  AppState,
  'browserPagesByWorkspace' | 'remoteBrowserPageHandlesByPageId'
>

export type BrowserWorkspaceTabClosePlan = {
  /**
   * Runtime environments to issue session.tabs.close against, in no particular order. A null
   * entry defers the choice to the session layer, which is all a pageless host mirror can do:
   * it has no page to name an owner with.
   */
  hostEnvironmentIds: (string | null)[]
  /** True when this renderer owns the teardown: destroy the webviews and drop the workspace. */
  closesLocally: boolean
  /**
   * True when the renderer must remove the visible tab itself. A host that still holds pages
   * removes its own mirror through tab sync; removing it here too would race that.
   */
  removesVisibleTab: boolean
  /**
   * Set when the local teardown unwinds a tab that was never finished being created. Such a close
   * owns no host page, so it must not reach the reopen stack or the empty-worktree landing.
   */
  localCloseReason?: 'cleanup'
}

/**
 * Who tears down a browser workspace's tab. A workspace can be owned by one runtime environment,
 * by several at once (pages opened against different environments), by none, or be a pageless
 * mirror of the focused runtime's host tab — and every one of those has to close, or the X does
 * nothing at all.
 */
export function planBrowserWorkspaceTabClose({
  state,
  workspaceId,
  focusedEnvironmentId,
  isEnvironmentActive
}: {
  state: BrowserWorkspaceTabCloseState
  workspaceId: string
  /** The worktree's runtime environment, which a pageless mirror belongs to. */
  focusedEnvironmentId: string | null | undefined
  isEnvironmentActive: (environmentId: string | null | undefined) => boolean
}): BrowserWorkspaceTabClosePlan {
  const closeLocally: BrowserWorkspaceTabClosePlan = {
    hostEnvironmentIds: [],
    closesLocally: true,
    removesVisibleTab: true
  }
  const pages = state.browserPagesByWorkspace[workspaceId] ?? []
  // Why: a staged page names an environment before the host has ever heard of the tab, so the owner
  // branch below would fan session.tabs.close at a page id that does not exist yet — an inert X, and
  // the in-flight create's snapshot then puts the tab back. The create path owns retiring the host
  // page; the strip only unwinds the rows this client minted. Must stay ahead of every other case.
  if (pages.some((page) => state.remoteBrowserPageHandlesByPageId[page.id]?.staged === true)) {
    return { ...closeLocally, localCloseReason: 'cleanup' }
  }
  const hasPages = pages.length > 0
  const ownerEnvironmentIds = getBrowserWorkspaceRemoteOwnerEnvironmentIds(state, workspaceId)
  if (ownerEnvironmentIds.length > 0) {
    const activeEnvironmentIds = ownerEnvironmentIds.filter((environmentId) =>
      isEnvironmentActive(environmentId)
    )
    // Why: with every owning host disconnected there is nobody to close on, so this renderer
    // finishes the teardown rather than leaving the tab standing.
    return activeEnvironmentIds.length === 0
      ? closeLocally
      : {
          hostEnvironmentIds: activeEnvironmentIds,
          closesLocally: false,
          // Why: owners are derived from this workspace's pages, so reaching here means it has
          // some — and a host that still holds pages removes its own mirror through tab sync.
          removesVisibleTab: false
        }
  }
  // Why: a workspace with pages of its own and no remote owner is a local fallback — the focused
  // runtime being connected does not make its tab the host's to close. A PAGELESS one is the
  // host's mirror and would otherwise be un-closable.
  if (hasPages || !isEnvironmentActive(focusedEnvironmentId)) {
    return closeLocally
  }
  return {
    hostEnvironmentIds: [focusedEnvironmentId ?? null],
    closesLocally: false,
    removesVisibleTab: true
  }
}
