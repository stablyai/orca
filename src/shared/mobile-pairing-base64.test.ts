import { describe, expect, it } from 'vitest'
import { normalizePairingBase64 } from './mobile-pairing-base64'
import { PAIRING_CODE_MAX_CHARACTERS } from './mobile-pairing-protocol-limits'

describe('pairing Base64 normalization', () => {
  it.each([
    ['Zg', 'Zg=='],
    ['Zg==', 'Zg=='],
    ['Zm8', 'Zm8='],
    ['Zm8=', 'Zm8='],
    ['Zm9v', 'Zm9v'],
    ['-_8', '+/8=']
  ])('preserves valid padded and unpadded input %s', (input, expected) => {
    expect(normalizePairingBase64(input)).toBe(expected)
  })

  it.each(['A', 'Zg=', 'Zm8==', 'Zg===', '=Zg=', 'Z g='])('rejects malformed input %s', (input) => {
    expect(() => normalizePairingBase64(input)).toThrow('Invalid pairing code')
  })

  it('rejects oversized input before decoding', () => {
    expect(() => normalizePairingBase64('A'.repeat(PAIRING_CODE_MAX_CHARACTERS + 1))).toThrow(
      'Invalid pairing code'
    )
  })
})
