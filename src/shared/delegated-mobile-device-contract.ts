import { z } from 'zod'
import type { RUNTIME_CAPABILITIES } from './protocol-version'

// Why: a paired desktop relays each of its phones to this host as an ordinary phone device it owns.
export const DELEGATED_MOBILE_DEVICE_SYNC_METHOD = 'pairing.delegatedMobileDevice.sync'
// Why: a desktop relays phones only to a host advertising this; `satisfies` ties it to RUNTIME_CAPABILITIES.
export const DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY =
  'pairing.delegated-mobile-devices.v1' satisfies (typeof RUNTIME_CAPABILITIES)[number]
export const DELEGATED_MOBILE_DEVICE_SYNC_MAX_PHONES = 32
export const DELEGATED_PHONE_NAME_MAX_CHARS = 128

const DelegatedPhoneSchema = z
  .object({
    phoneKey: z.string().min(1).max(128),
    name: z.string().min(1).max(DELEGATED_PHONE_NAME_MAX_CHARS)
  })
  .strict()

export const DelegatedMobileDeviceSyncParamsSchema = z
  .object({
    phones: z
      .array(DelegatedPhoneSchema)
      .max(DELEGATED_MOBILE_DEVICE_SYNC_MAX_PHONES)
      .refine((phones) => new Set(phones.map((phone) => phone.phoneKey)).size === phones.length, {
        message: 'duplicate phoneKey'
      })
  })
  .strict()

export type DelegatedPhone = z.infer<typeof DelegatedPhoneSchema>
export type DelegatedMobileDeviceSyncParams = z.infer<typeof DelegatedMobileDeviceSyncParamsSchema>

export type DelegatedMobileDeviceSyncResult = {
  devices: { phoneKey: string; deviceId: string; token: string }[]
}
