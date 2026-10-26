import { z } from 'zod'

/** installationId persists per profile; HMAC machineBinding hints at moved/copied profiles and is never identity alone. */
export const RuntimeHostDescriptorSchema = z.object({
  installationId: z
    .string()
    .regex(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/),
  machineBinding: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional()
})

export type RuntimeHostDescriptor = z.infer<typeof RuntimeHostDescriptorSchema>
