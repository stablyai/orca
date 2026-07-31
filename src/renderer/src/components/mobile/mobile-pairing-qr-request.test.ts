import { describe, expect, it } from 'vitest'
import { createMobilePairingQrRequest } from './mobile-pairing-qr-request'

describe('createMobilePairingQrRequest', () => {
  it('keeps the standard path backward-compatible', () => {
    expect(
      createMobilePairingQrRequest({
        addresses: ['100.64.1.20', '192.168.1.24'],
        connectionMode: 'automatic',
        orderedRoutes: false,
        relayPreferenceIndex: 1,
        rotate: false
      })
    ).toEqual({ address: '100.64.1.20', connectionMode: 'automatic' })
  })

  it('marks an advanced route list authoritative and preserves Relay order', () => {
    expect(
      createMobilePairingQrRequest({
        addresses: ['100.64.1.20', '192.168.1.24'],
        connectionMode: 'automatic',
        orderedRoutes: true,
        relayPreferenceIndex: 1,
        rotate: true
      })
    ).toEqual({
      addresses: ['100.64.1.20', '192.168.1.24'],
      connectionMode: 'automatic',
      orderedRoutes: true,
      relayPreferenceIndex: 1,
      rotate: true
    })
  })
})
