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
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  // Why: permissive decoders accept alternate spellings when unused trailing bits are non-zero.
  const trailingBits = padded.endsWith('==') ? 4 : padded.endsWith('=') ? 2 : 0
  if (trailingBits > 0) {
    const finalCharacter = padded[padded.length - trailingBits / 2 - 1]!
    const value = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(
      finalCharacter
    )
    if (value & ((1 << trailingBits) - 1)) {
      throw new Error('Invalid pairing code')
    }
  }
  return padded
}
