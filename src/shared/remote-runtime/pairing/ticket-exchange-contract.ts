import { z } from 'zod'

// Same shape as host-minted device tokens (24 random bytes, hex) with room for longer client tokens.
const DEVICE_TOKEN_PATTERN = /^[0-9a-f]{48,128}$/

export function isExchangeDeviceToken(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_TOKEN_PATTERN.test(value)
}

export const ExchangePairingTicketParamsSchema = z
  .object({
    // Generated on the client; it replaces the pairing token once the client first signs in with it.
    deviceToken: z
      .string()
      .refine(isExchangeDeviceToken, 'expected 48-128 lowercase hex characters')
  })
  .strict()

export type ExchangePairingTicketParams = z.infer<typeof ExchangePairingTicketParamsSchema>

export type ExchangePairingTicketResult = { deviceId: string }
