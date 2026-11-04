import type { AppState } from '@/store/types'
import type { BrowserPage } from '../../../shared/browser-workspace-types'

type RemoteBrowserTabOwnershipState = Pick<
  AppState,
  'browserPagesByWorkspace' | 'remoteBrowserPageHandlesByPageId'
>

export type BrowserWorkspaceRemoteOwnership =
  | { kind: 'none' }
  | { kind: 'exact'; environmentId: string }
  | { kind: 'ambiguous'; environmentIds: string[] }

/** The runtime environment a page runs on, or null for this desktop's own page. */
export function getBrowserPageRemoteOwnerEnvironmentId(
  state: Pick<RemoteBrowserTabOwnershipState, 'remoteBrowserPageHandlesByPageId'>,
  page: Pick<BrowserPage, 'id' | 'browserRuntimeEnvironmentId'>
): string | null {
  return (
    state.remoteBrowserPageHandlesByPageId[page.id]?.environmentId?.trim() ||
    page.browserRuntimeEnvironmentId?.trim() ||
    null
  )
}

/**
 * Every runtime environment holding at least one of this browser workspace's pages. A workspace
 * spans more than one when pages were opened against different environments, and each of those
 * hosts keeps its own mirror of the tab — so closing it means telling all of them.
 */
export function getBrowserWorkspaceRemoteOwnerEnvironmentIds(
  state: RemoteBrowserTabOwnershipState,
  workspaceId: string
): string[] {
  const environmentIds = new Set<string>()
  for (const page of state.browserPagesByWorkspace[workspaceId] ?? []) {
    const environmentId = getBrowserPageRemoteOwnerEnvironmentId(state, page)
    if (environmentId) {
      environmentIds.add(environmentId)
    }
  }
  return [...environmentIds]
}

export function getBrowserWorkspaceRemoteOwnership(
  state: RemoteBrowserTabOwnershipState,
  workspaceId: string
): BrowserWorkspaceRemoteOwnership {
  const environmentIds = getBrowserWorkspaceRemoteOwnerEnvironmentIds(state, workspaceId)
  if (environmentIds.length === 0) {
    return { kind: 'none' }
  }
  if (environmentIds.length > 1) {
    return { kind: 'ambiguous', environmentIds }
  }
  return { kind: 'exact', environmentId: environmentIds[0]! }
}

export function browserWorkspaceHasRemoteOwner(
  state: RemoteBrowserTabOwnershipState,
  workspaceId: string,
  environmentId: string | null | undefined
): boolean {
  const ownerEnvironmentId = environmentId?.trim()
  if (!ownerEnvironmentId) {
    return false
  }
  const pages = state.browserPagesByWorkspace[workspaceId] ?? []
  return pages.some((page) => {
    const handle = state.remoteBrowserPageHandlesByPageId[page.id]
    return (
      handle?.environmentId === ownerEnvironmentId ||
      page.browserRuntimeEnvironmentId === ownerEnvironmentId
    )
  })
}
