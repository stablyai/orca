import type { RuntimeStatus } from './runtime-types'
import type { PublicKnownRuntimeEnvironment } from './runtime-environments'
import type { FolderWorkspace } from './folder-workspace-types'
import { folderWorkspaceToWorktree } from './folder-workspace-worktree'
import { normalizeWorkspaceCreatorProvenance } from './workspace-creator-provenance'

type RuntimeStatusEntry = { status: Pick<RuntimeStatus, 'pairedDeviceId'> | null }

export const EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT: ReadonlyMap<string, string> = new Map()

/** This client's own device id on each paired server. */
export function getPairedDeviceIdsByEnvironment(
  environments: readonly Pick<PublicKnownRuntimeEnvironment, 'id' | 'pairedDeviceId'>[],
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

/**
 * The "Hide other-client workspaces" rule: a workspace this client did not create is someone
 * else's, including one created on the server itself. Phones record the owner they act for as the
 * creator (workspace-creator-context.ts). No creator, or an unnamed pairing, stays visible.
 */
export function isWorkspaceOwnedBySomeoneElse(
  worktree: { creatorProvenance?: unknown; runtimeOwnerEnvironmentId?: string },
  pairedDeviceIdsByEnvironment: ReadonlyMap<string, string>
): boolean {
  const creator = normalizeWorkspaceCreatorProvenance(worktree.creatorProvenance)
  if (!creator) {
    return false
  }
  const environmentId = worktree.runtimeOwnerEnvironmentId
  if (!environmentId) {
    return creator.kind !== 'host'
  }
  const pairedDeviceId = pairedDeviceIdsByEnvironment.get(environmentId)
  if (!pairedDeviceId) {
    return false
  }
  return creator.kind !== 'paired-device' || creator.deviceId !== pairedDeviceId
}

export function isFolderWorkspaceFromOtherDevice(
  workspace: FolderWorkspace,
  pairedDeviceIdsByEnvironment: ReadonlyMap<string, string>
): boolean {
  return isWorkspaceOwnedBySomeoneElse(
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
