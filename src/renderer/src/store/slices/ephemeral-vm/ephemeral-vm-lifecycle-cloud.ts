// Orca Cloud facts the VM lifecycle slice carries alongside the upstream runtime projection.
import type { AppState } from '../../types'
import type { EphemeralVmRuntimeRecord } from '../../../../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtimes'

/** The cloud fields of a projected workspace runtime. */
export type CloudEphemeralVmRuntimeFields = {
  /** Last lifecycle change (for a suspended record: when it went to sleep). */
  updatedAt?: number
  /** Orca Cloud workspace booted from an org environment build (dependencies preinstalled). */
  environmentBuildId?: string
  /** The project the workspace was started for; files it there while its runtime is asleep. */
  projectId?: string
}

export type CloudEphemeralVmLifecycleFields = {
  /** Live Orca Cloud runtimes' owning team by runtime environment; unfiled ones are absent. */
  cloudAccountIdByEnvironmentId: Record<string, string>
}

/** The environment build an Orca Cloud recipe result records, if any. */
function environmentBuildIdOf(record: EphemeralVmRuntimeRecord): string | undefined {
  const driver = record.recipeResult?.userData?.environmentDriver
  if (!driver || typeof driver !== 'object' || Array.isArray(driver)) {
    return undefined
  }
  const state = 'driverState' in driver ? driver.driverState : undefined
  const id =
    state && typeof state === 'object' && !Array.isArray(state) && 'environmentBuildId' in state
      ? state.environmentBuildId
      : undefined
  return typeof id === 'string' && id ? id : undefined
}

export function projectCloudEphemeralVmRuntimeFields(
  record: EphemeralVmRuntimeRecord
): CloudEphemeralVmRuntimeFields {
  const environmentBuildId = environmentBuildIdOf(record)
  return {
    updatedAt: record.updatedAt,
    ...(record.projectId ? { projectId: record.projectId } : {}),
    ...(environmentBuildId ? { environmentBuildId } : {})
  }
}

/** Which team owns each live Orca Cloud server, so lists can scope to the active team. */
export function projectCloudAccountsByEnvironment(
  records: readonly EphemeralVmRuntimeRecord[],
  retiredStatuses: ReadonlySet<EphemeralVmRuntimeRecord['status']>
): Record<string, string> {
  const byEnvironment: Record<string, string> = {}
  for (const record of records) {
    if (
      record.recipe?.provider === 'orca-cloud' &&
      record.runtimeEnvironmentId &&
      record.cloudAccountId &&
      !retiredStatuses.has(record.status)
    ) {
      byEnvironment[record.runtimeEnvironmentId] = record.cloudAccountId
    }
  }
  return byEnvironment
}

function sameAccounts(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

/** Adds the cloud owners to a refresh's store update; `state` itself when nothing changed. */
export function withCloudAccountsUpdate(
  state: AppState,
  accounts: Record<string, string>,
  update: AppState | Partial<AppState>
): AppState | Partial<AppState> {
  if (sameAccounts(state.cloudAccountIdByEnvironmentId ?? {}, accounts)) {
    return update
  }
  return { ...(update === state ? {} : update), cloudAccountIdByEnvironmentId: accounts }
}
