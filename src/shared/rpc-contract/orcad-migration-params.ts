import { z } from 'zod'

// Why unknown: the handler parses and digest-checks the manifest itself, so a malformed one is
// refused with a migration error rather than a generic params failure.
export const OrcadMigrationCatalogParams = z.object({ manifest: z.unknown() })
