import nacl from 'tweetnacl'
import { describe, expect, it } from 'vitest'
import {
  encodeDeviceProofMessage,
  isDevicePublicKeyB64,
  sanitizeDeviceLabel,
  verifyDeviceProof
} from './device-key-proof'

const hash = new Uint8Array(32).fill(7)
const hashB64 = Buffer.from(hash).toString('base64')
const key = nacl.sign.keyPair()
const devicePublicKeyB64 = Buffer.from(key.publicKey).toString('base64')

function proof(purpose: 'auth' | 'register', transcript = hash): string {
  return Buffer.from(
    nacl.sign.detached(encodeDeviceProofMessage(purpose, transcript), key.secretKey)
  ).toString('base64')
}

describe('device key proof', () => {
  it('domain-separates the purpose and binds the transcript', () => {
    const message = new TextDecoder().decode(encodeDeviceProofMessage('auth', hash).slice(0, 26))
    expect(message).toBe('orca-device-proof/v1\0auth\0')
    expect(
      verifyDeviceProof({
        devicePublicKeyB64,
        deviceProofB64: proof('auth'),
        purpose: 'auth',
        transcriptHashB64: hashB64
      })
    ).toBe(true)
    expect(
      verifyDeviceProof({
        devicePublicKeyB64,
        deviceProofB64: proof('register'),
        purpose: 'auth',
        transcriptHashB64: hashB64
      })
    ).toBe(false)
    expect(
      verifyDeviceProof({
        devicePublicKeyB64,
        deviceProofB64: proof('auth', new Uint8Array(32).fill(8)),
        purpose: 'auth',
        transcriptHashB64: hashB64
      })
    ).toBe(false)
    const otherKey = Buffer.from(nacl.sign.keyPair().publicKey).toString('base64')
    expect(
      verifyDeviceProof({
        devicePublicKeyB64: otherKey,
        deviceProofB64: proof('auth'),
        purpose: 'auth',
        transcriptHashB64: hashB64
      })
    ).toBe(false)
  })

  it('accepts only canonical base64 of the exact length', () => {
    expect(isDevicePublicKeyB64(devicePublicKeyB64)).toBe(true)
    expect(isDevicePublicKeyB64(devicePublicKeyB64.replace(/=$/, ''))).toBe(false)
    expect(isDevicePublicKeyB64(Buffer.alloc(31).toString('base64'))).toBe(false)
    expect(isDevicePublicKeyB64(42)).toBe(false)
  })

  it('strips control and bidi characters from labels', () => {
    expect(sanitizeDeviceLabel('My‮ Phone\u0000\n', 'x')).toBe('My Phone')
    expect(sanitizeDeviceLabel('‏\u0007', 'Fallback')).toBe('Fallback')
    expect(sanitizeDeviceLabel('a'.repeat(100), 'x')).toHaveLength(64)
    expect(sanitizeDeviceLabel(undefined, 'Fallback')).toBe('Fallback')
  })
})
