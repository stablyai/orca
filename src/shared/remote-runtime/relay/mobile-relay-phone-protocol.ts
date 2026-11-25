import { z } from 'zod'

const EpochMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const RelayPhoneHelloSchema = z.union([
  z
    .object({
      type: z.literal('relay-hello'),
      ok: z.literal(false),
      code: z.number().int().min(4000).max(4999)
    })
    .strict(),
  z
    .object({
      type: z.literal('relay-hello'),
      ok: z.literal(true),
      credentialKind: z.literal('invite'),
      leaseExpiresAt: EpochMsSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('relay-hello'),
      ok: z.literal(true),
      credentialKind: z.literal('resume'),
      leaseExpiresAt: EpochMsSchema,
      acceptedCredentialVersion: z.number().int().positive(),
      acceptedAs: z.enum(['current', 'grace']),
      resumeExpiresAt: EpochMsSchema,
      graceExpiresAt: EpochMsSchema.optional()
    })
    .strict()
])

export type RelayPhoneHello = z.infer<typeof RelayPhoneHelloSchema>

export const RelayMovedSchema = z
  .object({
    type: z.literal('relay-moved'),
    v: z.literal(1),
    cellUrl: z.string().refine((value) => {
      try {
        const parsed = new URL(value)
        return parsed.protocol === 'https:' && parsed.origin === value
      } catch {
        return false
      }
    }),
    assignmentEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
