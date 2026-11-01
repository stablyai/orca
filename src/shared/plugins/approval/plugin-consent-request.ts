import { z } from 'zod'

/** Bind desktop/serve consent writes to the exact reviewed manifest fingerprint, never just the currently installed key. */
export const pluginConsentRequestSchema = z
  .object({
    pluginKey: z.string().min(1),
    reviewedFingerprint: z.string().min(1).max(256),
    decision: z.enum(['approve', 'keep-disabled'])
  })
  // Why strip: a newer client may send an optional review field; the host stays the gate.
  .strip()

export type PluginConsentRequest = z.infer<typeof pluginConsentRequestSchema>
