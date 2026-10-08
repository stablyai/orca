import path from 'node:path'
import { installOrcadHostAdapters } from '../../../src/main/orcad/orcad-entry'
import type { Store } from '../../../src/main/persistence'
import { createProfileStateStore } from '../../../src/main/persistence/profile-state/profile-state-store-factory'

export function createDaemonGenerationProfileStore(directory: string): Store {
  installOrcadHostAdapters()
  // The bundled fixture has no profile writer worker; use the synchronous SQLite authority.
  return createProfileStateStore({
    dataFile: path.join(directory, 'orca-data.json'),
    databaseFile: path.join(directory, 'profile-state.sqlite'),
    profileId: 'legacy-close-fixture'
  }).store
}
