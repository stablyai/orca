import { z } from 'zod'

export const PortableSettingsImport = z
  .object({
    settings: z.record(z.string(), z.unknown()),
    /** Report what would change without writing. */
    dryRun: z.boolean().optional()
  })
  .strict()
