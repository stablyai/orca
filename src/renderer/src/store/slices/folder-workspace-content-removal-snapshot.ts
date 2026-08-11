import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { AppState } from '../types'
import type { FolderWorkspaceRendererOwnerRemoval } from './folder-workspace-renderer-teardown'

type ContentSnapshotState = Partial<
  Pick<
    AppState,
    | 'browserTabsByWorktree'
    | 'browserPagesByWorkspace'
    | 'remoteBrowserPageHandlesByPageId'
    | 'openFiles'
    | 'unifiedTabsByWorktree'
  >
>

export type FolderWorkspaceContentRemovalSnapshot = {
  retireBrowserWorkspaceIds: string[]
  retireEditorFileIds: string[]
  retireUnifiedTabIds: string[]
}

export function folderWorkspaceBrowserContentBelongsToRemovedOwner(
  explicitWorkspaceHostId: ExecutionHostId | undefined,
  pages: readonly AppState['browserPagesByWorkspace'][string][number][],
  remoteEnvironmentIds: readonly string[],
  ownerRemoval: FolderWorkspaceRendererOwnerRemoval
): boolean {
  const explicitHost = parseExecutionHostId(explicitWorkspaceHostId)
  const pageHostIds = new Set(
    pages.flatMap((page) => {
      const host = parseExecutionHostId(page.workspaceExecutionHostId)
      return host ? [host.id] : []
    })
  )
  if (explicitHost) {
    pageHostIds.add(explicitHost.id)
  }
  if (pageHostIds.size > 0) {
    return pageHostIds.size === 1 && pageHostIds.has(ownerRemoval.hostId)
  }
  if (ownerRemoval.kind !== 'runtime') {
    return false
  }
  const runtimeEnvironmentIds = new Set(
    pages.flatMap((page) =>
      page.browserRuntimeEnvironmentId ? [page.browserRuntimeEnvironmentId] : []
    )
  )
  remoteEnvironmentIds.forEach((environmentId) => runtimeEnvironmentIds.add(environmentId))
  return runtimeEnvironmentIds.size === 1 && runtimeEnvironmentIds.has(ownerRemoval.environmentId)
}

export function folderWorkspaceEditorFileBelongsToRemovedOwner(
  file: Pick<
    AppState['openFiles'][number],
    | 'externalSshTargetId'
    | 'operationProvenance'
    | 'runtimeEnvironmentId'
    | 'workspaceExecutionHostId'
  >,
  ownerRemoval: FolderWorkspaceRendererOwnerRemoval
): boolean {
  const hostIds = new Set<ExecutionHostId>()
  if (file.workspaceExecutionHostId) {
    const workspaceHost = parseExecutionHostId(file.workspaceExecutionHostId)
    if (!workspaceHost) {
      return false
    }
    hostIds.add(workspaceHost.id)
  }
  const provenanceRoute = file.operationProvenance?.generation.route
  if (provenanceRoute) {
    const provenanceHost = parseExecutionHostId(provenanceRoute.executionHostId)
    if (!provenanceHost) {
      return false
    }
    const runtimeEnvironmentId = provenanceRoute.runtimeEnvironmentId?.trim()
    if (runtimeEnvironmentId) {
      if (
        provenanceHost.kind === 'local' ||
        (provenanceHost.kind === 'runtime' && provenanceHost.environmentId !== runtimeEnvironmentId)
      ) {
        return false
      }
      hostIds.add(toRuntimeExecutionHostId(runtimeEnvironmentId))
    } else {
      if (provenanceHost.kind === 'runtime') {
        return false
      }
      hostIds.add(provenanceHost.id)
    }
  }
  if (file.externalSshTargetId?.trim()) {
    hostIds.add(toSshExecutionHostId(file.externalSshTargetId))
  }
  if (file.runtimeEnvironmentId?.trim()) {
    hostIds.add(toRuntimeExecutionHostId(file.runtimeEnvironmentId))
  }
  return hostIds.size === 1 && hostIds.has(ownerRemoval.hostId)
}

export function snapshotFolderWorkspaceContentRemoval(
  state: ContentSnapshotState,
  workspaceKey: string,
  ownerRemoval: FolderWorkspaceRendererOwnerRemoval | undefined
): FolderWorkspaceContentRemovalSnapshot {
  const retireBrowserWorkspaceIds = ownerRemoval
    ? (state.browserTabsByWorktree?.[workspaceKey] ?? [])
        .filter((workspace) =>
          folderWorkspaceBrowserContentBelongsToRemovedOwner(
            workspace.workspaceExecutionHostId,
            state.browserPagesByWorkspace?.[workspace.id] ?? [],
            (state.browserPagesByWorkspace?.[workspace.id] ?? []).flatMap((page) => {
              const environmentId = state.remoteBrowserPageHandlesByPageId?.[page.id]?.environmentId
              return environmentId ? [environmentId] : []
            }),
            ownerRemoval
          )
        )
        .map((workspace) => workspace.id)
    : []
  const editorFileIds = new Set(
    ownerRemoval
      ? (state.openFiles ?? [])
          .filter(
            (file) =>
              file.worktreeId === workspaceKey &&
              folderWorkspaceEditorFileBelongsToRemovedOwner(file, ownerRemoval)
          )
          .map((file) => file.id)
      : []
  )
  let addedDependentPreview = true
  while (addedDependentPreview) {
    addedDependentPreview = false
    for (const file of state.openFiles ?? []) {
      if (
        file.worktreeId === workspaceKey &&
        file.markdownPreviewSourceFileId &&
        editorFileIds.has(file.markdownPreviewSourceFileId) &&
        !editorFileIds.has(file.id)
      ) {
        editorFileIds.add(file.id)
        addedDependentPreview = true
      }
    }
  }
  const retireEditorFileIds = [...editorFileIds]
  const browserWorkspaceIds = new Set(retireBrowserWorkspaceIds)
  const retireUnifiedTabIds = (state.unifiedTabsByWorktree?.[workspaceKey] ?? [])
    .filter(
      (tab) =>
        (tab.contentType === 'browser' && browserWorkspaceIds.has(tab.entityId)) ||
        (tab.contentType !== 'browser' &&
          tab.contentType !== 'terminal' &&
          tab.contentType !== 'simulator' &&
          editorFileIds.has(tab.entityId))
    )
    .map((tab) => tab.id)
  return { retireBrowserWorkspaceIds, retireEditorFileIds, retireUnifiedTabIds }
}
