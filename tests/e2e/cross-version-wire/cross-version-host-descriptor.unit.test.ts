import { beforeAll, describe, expect, it } from 'vitest'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

/**
 * The host descriptor rides inside the pairing offer, which both sides parse with a schema. An old
 * client must still accept an offer from a new host (dropping the field), and a new client must
 * accept an offer from an old host that has none.
 */
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
const DESCRIPTOR = {
  installationId: '0b4c3d5e-1f2a-4b6c-8d7e-9f0a1b2c3d4e',
  machineBinding: 'A'.repeat(43)
}

let released: PairingModule
let current: PairingModule

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(RELEASE_REF)
  const [oldModule, newModule] = await Promise.all([
    importReleaseCheckoutModule(checkout, 'src/shared/pairing.ts'),
    import('../../../src/shared/pairing')
  ])
  released = pairingModuleOf(oldModule)
  current = pairingModuleOf(newModule)
}, SUITE_TIMEOUT_MS)

describe('cross-version host descriptor in the pairing offer', () => {
  it('pairs two real builds', () => {
    expect(released.parsePairingCode).not.toBe(current.parsePairingCode)
  })

  it('an old client pairs with a new host and drops the descriptor', () => {
    const url = current.encodePairingOffer({ ...BASE_OFFER, hostDescriptor: DESCRIPTOR })
    expect(released.parsePairingCode(url)).toEqual(BASE_OFFER)
    expect(current.parsePairingCode(url)).toEqual({ ...BASE_OFFER, hostDescriptor: DESCRIPTOR })
  })

  it('a new client pairs with an old host that sends no descriptor', () => {
    const url = released.encodePairingOffer(BASE_OFFER)
    expect(current.parsePairingCode(url)).toEqual(BASE_OFFER)
  })

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
