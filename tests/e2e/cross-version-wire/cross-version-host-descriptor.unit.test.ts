import { beforeAll, describe, expect, it } from 'vitest'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// Pairing-offer readers must tolerate a new host descriptor and its absence on old hosts.
const RELEASE_REF = 'v1.4.224'
const SUITE_TIMEOUT_MS = 180_000

type PairingModule = {
  encodePairingOffer(offer: Record<string, unknown>): string
  parsePairingCode(input: string): Record<string, unknown> | null
}

function pairingModuleOf(module: Record<string, unknown>): PairingModule {
  const { encodePairingOffer, parsePairingCode } = module
  if (typeof encodePairingOffer !== 'function' || typeof parsePairingCode !== 'function') {
    throw new Error('module does not export the pairing codec')
  }
  return {
    encodePairingOffer: (offer) => String(encodePairingOffer(offer)),
    parsePairingCode: (input) => parsePairingCode(input)
  }
}

const BASE_OFFER = {
  v: 2,
  endpoint: 'ws://100.64.1.20:6768',
  deviceToken: 'device-token',
  publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  pairedDeviceId: 'device-1',
  scope: 'runtime'
}

let released: PairingModule
let current: PairingModule

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(RELEASE_REF)
  const [oldModule, newModule] = await Promise.all([
    importReleaseCheckoutModule(checkout, 'src/shared/pairing.ts'),
    import('../../../src/shared/remote-runtime/pairing/pairing')
  ])
  released = pairingModuleOf(oldModule)
  current = pairingModuleOf(newModule)
}, SUITE_TIMEOUT_MS)

describe('cross-version host descriptor in the pairing offer', () => {
  it('a descriptor from a newer host in a shape this build cannot read never blocks pairing', () => {
    const futureDescriptor = { installationId: 'some-future-format', machineBinding: 42 }
    const url = released.encodePairingOffer(BASE_OFFER).replace(
      /code=(.*)$/,
      (_match, code: string) =>
        `code=${Buffer.from(
          JSON.stringify({
            ...JSON.parse(Buffer.from(code, 'base64url').toString('utf8')),
            hostDescriptor: futureDescriptor
          })
        ).toString('base64url')}`
    )
    expect(current.parsePairingCode(url)).toEqual(BASE_OFFER)
  })
})
