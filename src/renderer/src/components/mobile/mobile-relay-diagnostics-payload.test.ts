import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildMobileRelayDiagnosticsPayload,
  collectMobileRelayDiagnosticsPayload
} from './mobile-relay-diagnostics-payload'
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

// Why this matters beyond the field value: the payload is what a user pastes into a bug report,
// and both Copy-diagnostics buttons fire the collector as `void copyRelayDiagnostics()` with the
// await sitting ahead of their try/catch — so a rejection here is a click that writes no
// clipboard and shows no toast at all.
describe('collectMobileRelayDiagnosticsPayload', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window')
  })

  function stubWindow(mobile: unknown): void {
    const api: Record<string, unknown> = {}
    if (mobile !== undefined) {
      api.mobile = mobile
    }
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { api } })
  }

  it("reports 'unreadable' rather than the definite 'offline' when the status lookup fails", async () => {
    stubWindow({ getRelayStatus: vi.fn().mockRejectedValue(new Error('ipc down')) })

    const payload = await collectMobileRelayDiagnosticsPayload({
      connectionMode: 'automatic',
      failure
    })

    expect(payload.relayStatus).toBe('unreadable')
  })

  it('still resolves when the mobile bridge is missing entirely', async () => {
    stubWindow(undefined)

    await expect(
      collectMobileRelayDiagnosticsPayload({ connectionMode: 'automatic', failure })
    ).resolves.toMatchObject({ relayStatus: 'unreadable' })
  })

  it('reports a host-answered offline as offline', async () => {
    stubWindow({ getRelayStatus: vi.fn().mockResolvedValue({ status: 'offline' }) })

    const payload = await collectMobileRelayDiagnosticsPayload({
      connectionMode: 'automatic',
      failure
    })

    expect(payload.relayStatus).toBe('offline')
  })
})
