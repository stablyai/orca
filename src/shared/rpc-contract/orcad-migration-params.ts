import { z } from 'zod'
import {
  MAX_ORCAD_MIGRATION_BLOBS,
  OrcadMigrationBlobDescriptorSchema
} from '../orcad-migration/orcad-migration-blob-transfer'

// Why unknown: the handler parses and digest-checks the manifest itself, so a malformed one is
// refused with a migration error rather than a generic params failure.
export const OrcadMigrationCatalogParams = z.object({ manifest: z.unknown() })

// Optional: sent only to a blob-channel destination, so SSH and older peers see `{ manifest }`.
export const OrcadMigrationCommitCatalogParams = OrcadMigrationCatalogParams.extend({
  expectedBlobs: z
    .array(OrcadMigrationBlobDescriptorSchema)
    .max(MAX_ORCAD_MIGRATION_BLOBS)
    .optional()
})
