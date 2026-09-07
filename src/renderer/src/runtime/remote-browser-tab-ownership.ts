import type { AppState } from '@/store/types'

type RemoteBrowserTabOwnershipState = Pick<
  AppState,
  'browserPagesByWorkspace' | 'remoteBrowserPageHandlesByPageId'
>

export type BrowserWorkspaceRemoteOwnership =
  | { kind: 'none' }
  | { kind: 'exact'; environmentId: string }
  | { kind: 'ambiguous'; environmentIds: string[] }

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
    const environmentId =
      state.remoteBrowserPageHandlesByPageId[page.id]?.environmentId?.trim() ||
      page.browserRuntimeEnvironmentId?.trim()
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

export function getBrowserWorkspaceRemoteOwnerEnvironmentId(
  state: RemoteBrowserTabOwnershipState,
  workspaceId: string
): string | null {
  const ownership = getBrowserWorkspaceRemoteOwnership(state, workspaceId)
  return ownership.kind === 'exact' ? ownership.environmentId : null
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
