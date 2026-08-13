import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'

/** Matches the renderer's other catalog-style cache TTLs (checks, work items, Jira). */
export const RUNTIME_CATALOG_STALE_MS = 60_000

let lastCatalogListedAt = 0

/** Why: status coverage cannot observe catalog edits made by another client or the
 * orca CLI, so an old-enough listing must be re-read even when coverage looks complete. */
export function isRuntimeCatalogListingStale(): boolean {
  return Date.now() - lastCatalogListedAt > RUNTIME_CATALOG_STALE_MS
}

/** Why: this timestamp is module-global, so without a reset one test's clock leaks
 * into every test after it and makes list-count assertions order-dependent. */
export function resetRuntimeCatalogListingForTests(): void {
  lastCatalogListedAt = 0
}

type RuntimeStatusHydrationDependencies = {
  listEnvironments: () => Promise<PublicKnownRuntimeEnvironment[]>
  getCurrentEnvironments: () => readonly PublicKnownRuntimeEnvironment[]
  publishEnvironments: (environments: readonly PublicKnownRuntimeEnvironment[]) => void
  refreshEnvironmentStatus: (environmentId: string) => Promise<boolean>
  markCatalogSettled: () => void
}

function environmentRevisions(
  environments: readonly PublicKnownRuntimeEnvironment[]
): ReadonlyMap<string, number> {
  return new Map(
    environments.map((environment) => [
      environment.id,
      environment.pairingRevision ?? environment.createdAt
    ])
  )
}

function revisionsMatch(
  environments: readonly PublicKnownRuntimeEnvironment[],
  expected: ReadonlyMap<string, number>
): boolean {
  const current = environmentRevisions(environments)
  if (current.size !== expected.size) {
    return false
  }
  for (const [environmentId, revision] of current) {
    if (expected.get(environmentId) !== revision) {
      return false
    }
  }
  return true
}

export function createRuntimeStatusHydration({
  listEnvironments,
  getCurrentEnvironments,
  publishEnvironments,
  refreshEnvironmentStatus,
  markCatalogSettled
}: RuntimeStatusHydrationDependencies): () => Promise<void> {
  let inFlight: Promise<void> | null = null
  let expectedRevisions: ReadonlyMap<string, number> | null = null
  let rerunRequested = false

  return () => {
    if (inFlight) {
      if (expectedRevisions && !revisionsMatch(getCurrentEnvironments(), expectedRevisions)) {
        rerunRequested = true
      }
      return inFlight
    }
    const hydration = (async (): Promise<void> => {
      // Catalog changes queue a current-catalog pass without duplicating stable overlaps.
      do {
        rerunRequested = false
        const revisionsAtListStart = environmentRevisions(getCurrentEnvironments())
        expectedRevisions = revisionsAtListStart
        let environments: PublicKnownRuntimeEnvironment[]
        try {
          environments = await listEnvironments()
        } catch (err) {
          console.error('Failed to list runtime environments for status hydration:', err)
          markCatalogSettled()
          return
        }
        lastCatalogListedAt = Date.now()
        if (!revisionsMatch(getCurrentEnvironments(), revisionsAtListStart)) {
          rerunRequested = true
          continue
        }
        expectedRevisions = environmentRevisions(environments)
        publishEnvironments(environments)
        await Promise.allSettled(
          environments.map((environment) => refreshEnvironmentStatus(environment.id))
        )
      } while (
        rerunRequested ||
        (expectedRevisions && !revisionsMatch(getCurrentEnvironments(), expectedRevisions))
      )
    })()
    inFlight = hydration.finally(() => {
      inFlight = null
      expectedRevisions = null
      rerunRequested = false
    })
    return inFlight
  }
}
