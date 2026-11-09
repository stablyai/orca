import { z } from 'zod'

// Host-owner revoke of one paired device (runtime or phone). Unlike removing its row from
// orca-devices.json, which only blocks the next sign-in, this also closes the device's open sockets.
export const PAIRING_REVOKE_DEVICE_METHOD = 'pairing.revokeDevice'

export const PairingRevokeDeviceParamsSchema = z
  .object({
    deviceId: z.string().min(1).max(128)
  })
  .strict()

export type PairingRevokeDeviceParams = z.infer<typeof PairingRevokeDeviceParamsSchema>

/** `revoked: false` when no such device was paired (already gone). */
export type PairingRevokeDeviceResult = { revoked: boolean }
