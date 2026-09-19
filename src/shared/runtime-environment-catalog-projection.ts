import type { KnownRuntimeEnvironment } from './runtime-environments'

type CatalogRegistration = Pick<KnownRuntimeEnvironment, 'id' | 'reconciliation'>
export type RuntimeEnvironmentCatalogEntry<T extends CatalogRegistration> = {
  environment: T
  historicalEnvironmentIds: string[]
}

/** Keep the full registry for storage and session ownership; this is only a selection projection. */
export function projectRuntimeEnvironmentCatalog<T extends CatalogRegistration>(
  environments: readonly T[]
): RuntimeEnvironmentCatalogEntry<T>[] {
  const byId = new Map(environments.map((environment) => [environment.id, environment]))
  const duplicateIds = new Set<string>()
  const seen = new Set<string>()
  for (const environment of environments) {
    if (seen.has(environment.id)) {
      duplicateIds.add(environment.id)
    }
    seen.add(environment.id)
  }
  return environments.flatMap((environment) => {
    const record = environment.reconciliation
    const complete =
      record?.stage === 'catalog-active' &&
      new Set(record.registrations.map((entry) => entry.environmentId)).size === 2 &&
      record.registrations.some((entry) => entry.environmentId === environment.id) &&
      record.registrations.every(
        (entry) =>
          !duplicateIds.has(entry.environmentId) &&
          JSON.stringify(byId.get(entry.environmentId)?.reconciliation) === JSON.stringify(record)
      ) &&
      record.registrations.some((entry) => entry.environmentId === record.canonicalEnvironmentId)
    if (!complete) {
      return [{ environment, historicalEnvironmentIds: [] }]
    }
    return record.canonicalEnvironmentId === environment.id
      ? [
          {
            environment,
            historicalEnvironmentIds: record.registrations
              .map((entry) => entry.environmentId)
              .filter((id) => id !== environment.id)
          }
        ]
      : []
  })
}
