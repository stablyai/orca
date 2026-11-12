import type { OrcaBridge } from './declarative-runtime-types'
import { readHostMessage } from './declarative-host-messages'
import type { OrcaPersistedEntry } from './declarative-atoms'
import { createDeclarativePersistence } from './declarative-storage-sync'

export type HydratedPersistFields = { entries: OrcaPersistedEntry[]; hydration?: number }

/**
 * Persistence that tags each write with the host's id for the hydrate its values came from, so
 * a write made before a workspace switch is stored under the workspace it was made in.
 */
export function createHydratedPersistence(options: {
  bridge: OrcaBridge | null
  report: (error: unknown) => void
  post: (fields: HydratedPersistFields) => void
  hydratePanel: (payload: unknown) => void
}): {
  persistence: ReturnType<typeof createDeclarativePersistence>
  hydrate: (payload: unknown) => void
} {
  let hydration: number | undefined
  const persistence = createDeclarativePersistence({
    bridge: options.bridge,
    report: options.report,
    post: (entries) => options.post({ entries, ...(hydration === undefined ? {} : { hydration }) })
  })

  function hydrate(payload: unknown): void {
    // Why flush first: pending writes read their atoms' values, which this hydrate replaces
    // (with another workspace's, after a switch); post them under the values' own hydration.
    persistence.flush()
    const next = readHostMessage(payload).hydration
    if (typeof next === 'number') {
      hydration = next
    }
    options.hydratePanel(payload)
  }

  return { persistence, hydrate }
}
