import { readEnvironmentStore } from './runtime-environment-store-file'
import { resolveEnvironmentFromStore } from './runtime-environment-store'
import type { KnownRuntimeEnvironment } from './runtime-environments'
import {
  projectRuntimeEnvironmentCatalog,
  type RuntimeEnvironmentCatalogEntry
} from './runtime-environment-catalog-projection'

/** Catalog visibility never defines ownership of historical sessions or browser storage. */
export function listRuntimeEnvironmentCatalog(
  userDataPath: string
): RuntimeEnvironmentCatalogEntry<KnownRuntimeEnvironment>[] {
  return projectRuntimeEnvironmentCatalog(readEnvironmentStore(userDataPath).environments)
}

export function resolveRuntimeEnvironmentCatalogEntry(userDataPath: string, selector: string) {
  const store = readEnvironmentStore(userDataPath)
  const requested = resolveEnvironmentFromStore(store, selector)
  const record = requested.reconciliation
  return {
    requestedEnvironmentId: requested.id,
    environment:
      record?.stage === 'catalog-active'
        ? resolveEnvironmentFromStore(store, record.canonicalEnvironmentId)
        : requested
  }
}
