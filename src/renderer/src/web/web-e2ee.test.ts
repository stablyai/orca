import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_E2EE_ENCRYPTED_BASE64_CHARACTERS } from '../../../shared/e2ee-crypto'
import { decrypt, publicKeyFromBase64, WEB_E2EE_PUBLIC_KEY_MAX_BASE64_CHARACTERS } from './web-e2ee'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('web E2EE decode admission', () => {
  it('rejects an oversized public key before base64 decoding', () => {
    const atob = vi.fn(() => '')
    vi.stubGlobal('window', { atob })

    expect(() =>
      publicKeyFromBase64('A'.repeat(WEB_E2EE_PUBLIC_KEY_MAX_BASE64_CHARACTERS + 1))
    ).toThrow('encoded value is too large')
    expect(atob).not.toHaveBeenCalled()
  })

  it('admits encrypted text at the boundary and rejects one extra character before decoding', () => {
    const atob = vi.fn(() => '')
    vi.stubGlobal('window', { atob })
    const sharedKey = new Uint8Array(32)

    expect(decrypt('A'.repeat(MAX_E2EE_ENCRYPTED_BASE64_CHARACTERS), sharedKey)).toBeNull()
    expect(atob).toHaveBeenCalledOnce()
    atob.mockClear()

    expect(decrypt('A'.repeat(MAX_E2EE_ENCRYPTED_BASE64_CHARACTERS + 1), sharedKey)).toBeNull()
    expect(atob).not.toHaveBeenCalled()
  })
})
