import { z } from 'zod'

/** A paired phone asks its signed-in desktop to enroll the phone's own key with Orca Cloud, so the
 *  phone can then reach cloud workspaces directly with no desktop in the path. */
export const ORCA_CLOUD_ENROLL_DEVICE_METHOD = 'orcaCloud.enrollDevice'

export const OrcaCloudEnrollDeviceParamsSchema = z
  .object({
    label: z.string().trim().min(1).max(64),
    platform: z.enum(['ios', 'android', 'web']),
    /** Standard base64 of the phone's raw 32-byte Ed25519 public key; the private key never leaves it. */
    publicKeyB64: z.string().regex(/^[A-Za-z0-9+/]{43}=$/)
  })
  .strict()

export type OrcaCloudEnrollDeviceParams = z.infer<typeof OrcaCloudEnrollDeviceParamsSchema>

export const OrcaCloudDeviceSessionSchema = z.object({
  id: z.string().regex(/^ds_[A-Za-z0-9_-]{22}$/),
  label: z.string(),
  platform: z.enum(['ios', 'android', 'web']),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable().optional(),
  expiresAt: z.number(),
  current: z.boolean().optional()
})

export type OrcaCloudDeviceSession = z.infer<typeof OrcaCloudDeviceSessionSchema>

export const OrcaCloudEnrollDeviceResultSchema = z.object({
  controlPlaneUrl: z.string().url(),
  deviceSession: OrcaCloudDeviceSessionSchema
})

export type OrcaCloudEnrollDeviceResult = z.infer<typeof OrcaCloudEnrollDeviceResultSchema>

/** Error codes the phone maps to guidance. */
export const ORCA_CLOUD_ENROLLMENT_UNAVAILABLE = 'orca_cloud_unavailable'
export const ORCA_CLOUD_ENROLLMENT_SIGNED_OUT = 'orca_cloud_signed_out'
/** Too many devices, or this key was revoked: the phone rotates its key before asking again. */
export const ORCA_CLOUD_ENROLLMENT_REFUSED = 'orca_cloud_device_refused'
