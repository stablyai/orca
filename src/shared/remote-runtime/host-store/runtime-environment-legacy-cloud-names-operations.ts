import { normalizeTypedName } from '../../text/typed-name-normalization'
import { legacyOrcaCloudEnvironmentName } from '../host-catalog/orca-cloud-environment-name'
import { readPersistedEnvironmentStore, writeEnvironmentStore } from './runtime-environment-store-file'

/**
 * Renames saved "<repo> VM <id tail>" Orca Cloud servers to "<repo> sandbox <id tail>". `renames` maps an
 * environment id to its Orca Cloud runtime id. Names stay unique. Returns how many were renamed.
 */
export function renameLegacyOrcaCloudEnvironmentNames(
  userDataPath: string,
  renames: readonly (readonly [environmentId: string, runtimeId: string])[]
): number {
  const runtimeIdByEnvironment = new Map(renames)
  const store = readPersistedEnvironmentStore(userDataPath)
  const taken = new Set(
    store.environments.map((environment) => normalizeTypedName(environment.name))
  )
  let renamed = 0
  const environments = store.environments.map((environment) => {
    const runtimeId = runtimeIdByEnvironment.get(environment.id)
    const next =
      environment.source === 'ephemeral-vm' && runtimeId
        ? legacyOrcaCloudEnvironmentName(environment.name, runtimeId)
        : null
    // Never take a name another saved server already has.
    if (!next || taken.has(normalizeTypedName(next))) {
      return environment
    }
    taken.add(normalizeTypedName(next))
    renamed++
    return { ...environment, name: next }
  })
  if (renamed > 0) {
    writeEnvironmentStore(userDataPath, { ...store, environments })
  }
  return renamed
}
