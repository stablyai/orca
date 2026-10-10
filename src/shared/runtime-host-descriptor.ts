import { z } from 'zod'

/**
 * What a runtime host says about its own installation. `installationId` is generated once per
 * profile; `machineBinding` is HMAC(installationId, machine id + profile path) and is only a hint
 * that the profile moved or was copied, never an identity on its own.
 */
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
