import { PAIRING_CODE_MAX_CHARACTERS } from './mobile-pairing-protocol-limits'

export function normalizePairingBase64(base64url: string): string {
  if (
    base64url.length === 0 ||
    base64url.length > PAIRING_CODE_MAX_CHARACTERS ||
    !/^[A-Za-z0-9+/_-]+={0,2}$/.test(base64url)
  ) {
    throw new Error('Invalid pairing code')
  }
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (base64.length % 4 === 1) {
    throw new Error('Invalid pairing code')
  }
  // Saved codes may have partial padding or unused trailing bits; preserve their decoded bytes.
  return base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
}
