import { describe, expect, it } from 'vitest'
import { buildMobileRelayDiagnosticsPayload } from './mobile-relay-diagnostics-payload'
import type { MobileRelayMintFailure } from '../../../../shared/mobile-relay-mint-failure'

const failure: MobileRelayMintFailure = {
  code: 'relay_signed_out',
  stage: 'create_pairing_relay',
  message: 'Relay pairing invite request failed'
}

describe('buildMobileRelayDiagnosticsPayload', () => {
  it('includes the live relay status and app version', () => {
    const payload = buildMobileRelayDiagnosticsPayload({
      connectionMode: 'automatic',
      failure,
      relayStatus: 'offline',
      appVersion: '1.4.188'
    })

    expect(payload).toMatchObject({
      kind: 'mobile_pairing_relay_failure',
      preferredConnectionMode: 'automatic',
      failure,
      relayStatus: 'offline',
      appVersion: '1.4.188'
    })
    expect(typeof payload.at).toBe('string')
  })

  it('never carries a network identifier — only status and version leave the desktop', () => {
    const payload = buildMobileRelayDiagnosticsPayload({
      connectionMode: 'local-only',
      failure,
      relayStatus: 'registered',
      appVersion: '1.4.188'
    })

    expect(Object.keys(payload)).toEqual([
      'kind',
      'preferredConnectionMode',
      'failure',
      'relayStatus',
      'appVersion',
      'at'
    ])
    expect(payload).not.toHaveProperty('selectedAddress')
    expect(payload).not.toHaveProperty('cellUrl')
  })
})
