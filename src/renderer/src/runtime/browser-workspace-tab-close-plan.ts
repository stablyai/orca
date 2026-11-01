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

/** Close must handle zero, one or several page-owning environments plus pageless focused-runtime mirrors; no ownership shape may leave the X inert. */
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
  // Staged tabs name a host before page creation; host-close would hit an unknown ID and creation would restore it. Unwind client rows first; creation owns host retirement.
  if (pages.some((page) => state.remoteBrowserPageHandlesByPageId[page.id]?.staged === true)) {
    return { ...closeLocally, localCloseReason: 'cleanup' }
  }
  const hasPages = pages.length > 0
  const ownerEnvironmentIds = getBrowserWorkspaceRemoteOwnerEnvironmentIds(state, workspaceId)
  if (ownerEnvironmentIds.length > 0) {
    const activeEnvironmentIds = ownerEnvironmentIds.filter((environmentId) =>
      isEnvironmentActive(environmentId)
    )
    // When all owners disconnect, renderer teardown prevents an inert close.
    return activeEnvironmentIds.length === 0
      ? closeLocally
      : {
          hostEnvironmentIds: activeEnvironmentIds,
          closesLocally: false,
          // Page owners remove mirrors through sync; avoid racing their retraction.
          removesVisibleTab: false
        }
  }
  // Own pages without remote owners mean local fallback. Only pageless workspaces mirror the focused runtime’s tab.
  if (hasPages || !isEnvironmentActive(focusedEnvironmentId)) {
    return closeLocally
  }
  return {
    hostEnvironmentIds: [focusedEnvironmentId ?? null],
    closesLocally: false,
    removesVisibleTab: true
  }
}
