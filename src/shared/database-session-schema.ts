import { z } from 'zod'

export const databaseTabStateSchema = z
  .object({
    profileId: z.string().optional(),
    connection: z.object({
      providerId: z.literal('postgres'),
      host: z.string(),
      port: z.number().int().min(1).max(65_535),
      database: z.string(),
      schema: z.string().optional(),
      user: z.string(),
      sslMode: z.enum(['disable', 'require', 'verify-full'])
    }),
    queryDraft: z.string(),
    readOnly: z.boolean()
  })
  .optional()
