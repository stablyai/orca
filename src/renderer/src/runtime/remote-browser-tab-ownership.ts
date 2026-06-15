import type { AppState } from '@/store/types'

type RemoteBrowserTabOwnershipState = Pick<
  AppState,
  'browserPagesByWorkspace' | 'remoteBrowserPageHandlesByPageId'
>

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
