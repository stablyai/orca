import { PAIRING_CODE_MAX_CHARACTERS } from './mobile-pairing-protocol-limits'

export function normalizePairingBase64(base64url: string): string {
  if (
    base64url.length === 0 ||
    base64url.length > PAIRING_CODE_MAX_CHARACTERS ||
    base64url.length % 4 === 1 ||
    (base64url.includes('=') && base64url.length % 4 !== 0) ||
    !/^[A-Za-z0-9+/_-]+={0,2}$/.test(base64url)
  ) {
    throw new Error('Invalid pairing code')
  }
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  return base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
}
