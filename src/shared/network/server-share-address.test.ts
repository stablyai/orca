import { describe, it, expect } from 'vitest'
import { PAIRING_ENDPOINT_MAX_CHARACTERS } from '../remote-runtime/pairing/mobile-pairing-protocol-limits'
import { parseServerShareAddress } from './server-share-address'

describe('parseServerShareAddress', () => {
  it.each([
    ['https://orca.example.com', 'wss://orca.example.com'],
    ['  HTTPS://orca.example.com/  ', 'wss://orca.example.com'],
    ['https://orca.example.com:443', 'wss://orca.example.com'],
    [
      'https://orca.example.com:8443/%6Fruntime?route=%72ed',
      'wss://orca.example.com:8443/%6Fruntime?route=%72ed'
    ]
  ])('normalizes a pasted HTTPS tunnel URL to WSS: %s', (input, expected) => {
    expect(parseServerShareAddress(input)).toEqual({ ok: true, value: expected })
  })

  it.each([
    'https://user:secret@orca.example.com',
    'https://orca.example.com/#secret',
    'https://orca.example.com:0',
    'https://orca.example.com:65536',
    'https://0.0.0.0',
    'https://[::]',
    'https://orca.example.com/has space',
    'https://orca.example.com/path\u0001',
    `https://orca.example.com/${'a'.repeat(PAIRING_ENDPOINT_MAX_CHARACTERS)}`
  ])('rejects an unsafe HTTPS tunnel address %j', (input) => {
    expect(parseServerShareAddress(input).ok).toBe(false)
  })
})
