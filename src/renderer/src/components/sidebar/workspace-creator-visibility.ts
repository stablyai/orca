import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { workspaceCreatorRelation } from '../../../../shared/workspace-creator-provenance'

type RuntimeStatusEntry = { status: RuntimeStatus | null }

export const EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT: ReadonlyMap<string, string> = new Map()

export function getPairedDeviceIdsByEnvironment(
  environments: readonly PublicKnownRuntimeEnvironment[],
  statuses: ReadonlyMap<string, RuntimeStatusEntry>
): ReadonlyMap<string, string> {
  const result = new Map<string, string>()
  for (const environment of environments) {
    const deviceId =
      statuses.get(environment.id)?.status?.pairedDeviceId ?? environment.pairedDeviceId
    if (deviceId) {
      result.set(environment.id, deviceId)
    }
  }
  return result
}

export function isWorkspaceFromOtherDevice(
  worktree: Worktree,
  pairedDeviceIdsByEnvironment: ReadonlyMap<string, string>
): boolean {
  const environmentId = worktree.runtimeOwnerEnvironmentId
  if (!environmentId) {
    return workspaceCreatorRelation(worktree.creatorProvenance, null) !== 'viewer'
  }
  const pairedDeviceId = pairedDeviceIdsByEnvironment.get(environmentId)
  if (!pairedDeviceId) {
    return false
  }
  return workspaceCreatorRelation(worktree.creatorProvenance, pairedDeviceId) !== 'viewer'
}

export function isFolderWorkspaceFromOtherDevice(
  workspace: FolderWorkspace,
  pairedDeviceIdsByEnvironment: ReadonlyMap<string, string>
): boolean {
  return isWorkspaceFromOtherDevice(
    folderWorkspaceToWorktree(workspace),
    pairedDeviceIdsByEnvironment
  )
}

export function filterFolderWorkspacesFromOtherDevices(
  workspaces: readonly FolderWorkspace[],
  pairedDeviceIdsByEnvironment: ReadonlyMap<string, string>
): FolderWorkspace[] {
  return workspaces.filter(
    (workspace) => !isFolderWorkspaceFromOtherDevice(workspace, pairedDeviceIdsByEnvironment)
  )
}
