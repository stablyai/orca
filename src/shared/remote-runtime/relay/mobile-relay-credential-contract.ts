import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

const OpaqueIdSchema = lazyZodSchema(() => z.string().min(1).max(128))
const Base64Url32ByteSchema = lazyZodSchema(() => z.string().regex(/^[A-Za-z0-9_-]{43}$/))
const EpochMsSchema = lazyZodSchema(() =>
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
)
const RelayHostIdSchema = lazyZodSchema(() => z.string().regex(/^[A-Za-z0-9_-]{16}$/))

function isCanonicalHttpsOrigin(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && value === parsed.origin
  } catch {
    return false
  }
}

export const PairingProvisionRelayParamsSchema = lazyZodSchema(() =>
  z
    .object({
      reqId: OpaqueIdSchema,
      newResumeTokenHash: Base64Url32ByteSchema,
      expectedCurrentHash: Base64Url32ByteSchema.optional()
    })
    .strict()
)

export const PairingGetEndpointsParamsSchema = lazyZodSchema(() =>
  z
    .object({
      installReqId: OpaqueIdSchema.optional(),
      resumeConfirmReqId: OpaqueIdSchema.optional()
    })
    .strict()
)

export const DeviceCredentialInstalledSchema = lazyZodSchema(() =>
  z
    .object({
      v: z.literal(1),
      reqId: OpaqueIdSchema,
      authorizationMode: z.enum(['relay-basis', 'authenticated-direct']),
      currentVersion: z.number().int().positive(),
      resumeExpiresAt: EpochMsSchema,
      graceExpiresAt: EpochMsSchema.optional()
    })
    .strict()
)

export const DeviceCredentialInstallStatusResultSchema = lazyZodSchema(() =>
  z.union([
    z.object({ v: z.literal(1), reqId: OpaqueIdSchema, state: z.literal('not-found') }).strict(),
    z
      .object({
        v: z.literal(1),
        reqId: OpaqueIdSchema,
        state: z.literal('committed'),
        result: DeviceCredentialInstalledSchema
      })
      .strict()
  ])
)

export const DeviceResumeConfirmedSchema = lazyZodSchema(() =>
  z
    .object({
      v: z.literal(1),
      reqId: OpaqueIdSchema,
      currentVersion: z.number().int().positive(),
      acceptedAs: z.enum(['current', 'grace']),
      renewed: z.boolean(),
      resumeExpiresAt: EpochMsSchema,
      graceExpiresAt: EpochMsSchema.optional()
    })
    .strict()
)

export const MobileRelayEndpointSchema = lazyZodSchema(() =>
  z
    .object({
      v: z.literal(1),
      directorUrl: z.string().refine(isCanonicalHttpsOrigin),
      cellUrl: z.string().refine(isCanonicalHttpsOrigin),
      assignmentEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      relayHostId: RelayHostIdSchema,
      e2eeFraming: z.literal(2)
    })
    .strict()
)

export const PairingGetEndpointsResultSchema = lazyZodSchema(() =>
  z
    .object({
      v: z.literal(1),
      relay: MobileRelayEndpointSchema.nullable(),
      installStatus: DeviceCredentialInstallStatusResultSchema.optional(),
      resumeConfirmation: DeviceResumeConfirmedSchema.optional()
    })
    .strict()
)

export type PairingProvisionRelayParams = z.infer<typeof PairingProvisionRelayParamsSchema>
export type PairingGetEndpointsParams = z.infer<typeof PairingGetEndpointsParamsSchema>
export type DeviceCredentialInstalled = z.infer<typeof DeviceCredentialInstalledSchema>
export type DeviceCredentialInstallStatusResult = z.infer<
  typeof DeviceCredentialInstallStatusResultSchema
>
export type DeviceResumeConfirmed = z.infer<typeof DeviceResumeConfirmedSchema>
export type MobileRelayEndpoint = z.infer<typeof MobileRelayEndpointSchema>
export type PairingGetEndpointsResult = z.infer<typeof PairingGetEndpointsResultSchema>
