import type {
  EphemeralVmRuntimeRecord,
  EphemeralVmRuntimeStatus
} from '../../../../../../shared/ephemeral-vm-runtimes'

const T0 = 1_800_000_000_000

/** A persisted VM record as main lists it: an Orca Cloud sandbox unless `cloud` is false. */
export function cloudVmRecord(
  workspaceId: string,
  status: EphemeralVmRuntimeStatus,
  cloud = true
): EphemeralVmRuntimeRecord {
  return {
    id: `runtime-${workspaceId}`,
    recipeId: cloud ? 'orca-cloud' : 'recipe-vm',
    recipe: {
      id: cloud ? 'orca-cloud' : 'recipe-vm',
      name: cloud ? 'Orca Cloud' : 'Recipe VM',
      create: 'create',
      ...(cloud ? { provider: 'orca-cloud' as const } : {})
    },
    workspaceId,
    status,
    cleanupStatus: 'not_started',
    createdAt: T0,
    updatedAt: T0
  }
}
