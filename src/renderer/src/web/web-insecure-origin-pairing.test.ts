import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PAIRING_OFFER_VERSION } from '../../../shared/mobile-relay-pairing-offer'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const offer = {
  v: PAIRING_OFFER_VERSION,
  endpoint: 'ws://100.108.226.109:6768',
  deviceToken: 'pairing-code',
  publicKeyB64: 'host-key'
} as const

// A fresh module graph is what a page reload gives the web bundle: no in-memory pairing survives.
async function loadWebClient() {
  vi.resetModules()
  const support = await import('./web-device-key-support')
  support.setWebDeviceKeySupportForTests('token-insecure-origin')
  return {
    environment: await import('./web-runtime-environment'),
    credentials: await import('./preload-api/web-runtime-credentials'),
    guidance: await import('./web-pairing-security-guidance')
  }
}

describe('a plain-http page on another machine (LAN or Tailscale)', () => {
  beforeEach(() => {
    const items = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => items.set(key, value),
        removeItem: (key: string) => items.delete(key)
      }
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('stays paired across a reload and signs in with the stored pairing code', async () => {
    const before = await loadWebClient()
    const paired = before.environment.createStoredWebRuntimeEnvironment({ name: 'Desk', offer })
    expect(paired.sessionOnly).toBeUndefined()
    before.environment.saveStoredWebRuntimeEnvironment(paired)

    const after = await loadWebClient()
    const restored = after.environment.readStoredWebRuntimeEnvironment()
    expect(restored).toMatchObject({ id: paired.id, endpoints: [{ deviceToken: 'pairing-code' }] })
    const source = after.credentials.webRuntimeCredentialFor(restored!, {
      forgetStoredToken: vi.fn(),
      forgetPairing: vi.fn()
    })
    expect(source.nextPlan(true)).toEqual({ kind: 'legacy-token', deviceToken: 'pairing-code' })
  })

  it('shows no pairing-security notice', async () => {
    const { environment, guidance } = await loadWebClient()
    const paired = environment.createStoredWebRuntimeEnvironment({ name: 'Desk', offer })
    expect(guidance.webPairingSecurityGuidance('token-insecure-origin', paired)).toBeNull()
    expect(guidance.webSessionPairingGuidance('token-insecure-origin')).toBeNull()
  })
})
