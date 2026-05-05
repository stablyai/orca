import { z } from 'zod'

export const PAIRING_OFFER_VERSION = 2

export const PairingOfferSchema = z.object({
  v: z.literal(PAIRING_OFFER_VERSION),
  endpoint: z.string().min(1),
  deviceToken: z.string().min(1),
  // Why: the desktop's Curve25519 public key, base64-encoded. The mobile client
  // uses this to derive a shared secret via ECDH for end-to-end encryption.
  publicKeyB64: z.string().min(1)
})

export type PairingOffer = z.infer<typeof PairingOfferSchema>

export function encodePairingOffer(offer: PairingOffer): string {
  const json = JSON.stringify(offer)
  const base64url = Buffer.from(json, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `orca://pair#${base64url}`
}

export function decodePairingOffer(url: string): PairingOffer {
  const hashIndex = url.indexOf('#')
  if (!url.startsWith('orca://pair') || hashIndex === -1) {
    throw new Error('Invalid pairing URL: must start with orca://pair#')
  }
  const base64url = url.slice(hashIndex + 1)
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const json = Buffer.from(base64, 'base64').toString('utf-8')
  return PairingOfferSchema.parse(JSON.parse(json))
}
