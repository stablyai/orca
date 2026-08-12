import { z } from 'zod'

/**
 * Experimental consent write contract shared by desktop IPC and serve RPC.
 * The reviewed fingerprint makes approval conditional on the exact manifest
 * trust boundary the user saw, rather than whichever same-key plugin is current.
 */
export const pluginConsentRequestSchema = z
  .object({
    pluginKey: z.string().min(1),
    reviewedFingerprint: z.string().min(1).max(256),
    decision: z.enum(['approve', 'keep-disabled'])
  })
  .strict()

export type PluginConsentRequest = z.infer<typeof pluginConsentRequestSchema>
