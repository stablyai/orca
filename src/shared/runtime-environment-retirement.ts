import { resolveEnvironmentFromStore } from './runtime-environment-store'
import { readPersistedEnvironmentStore } from './runtime-environment-store-file'
import {
  readCurrentRuntimeEnvironmentSidecarEntry,
  writeRuntimeEnvironmentSidecarEntry
} from './runtime-environment-sidecar'

/**
 * Records that a server's host is gone for good (its machine was deleted), so nothing dials it on
 * any later launch. The record stays: worktrees on it still resolve to their Gone machine, and
 * forgetting the server remains the user's choice. A re-pair makes the marker stale.
 */
export function setRuntimeEnvironmentRetirement(
  userDataPath: string,
  environmentId: string,
  retiredAt: string | null
): void {
  const store = readPersistedEnvironmentStore(userDataPath)
  const persisted = resolveEnvironmentFromStore(store, environmentId)
  const entry = readCurrentRuntimeEnvironmentSidecarEntry(userDataPath, persisted)
  if ((entry?.retiredAt ?? null) === retiredAt) {
    return
  }
  const { binding: _binding, retiredAt: _previous, ...rest } = entry ?? { binding: null }
  writeRuntimeEnvironmentSidecarEntry(userDataPath, store.environments, persisted, {
    ...rest,
    ...(retiredAt ? { retiredAt } : {})
  })
}
