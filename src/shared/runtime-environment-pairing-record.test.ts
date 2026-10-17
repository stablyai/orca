import { describe, expect, it } from 'vitest'
import { encodePairingOffer, type PairingOffer } from './pairing'
import {
  assertNewEnvironmentIdAndName,
  isSamePairingOffer,
  parseLoopbackPairingCode,
  repairedPersistedEnvironment,
  withEnvironmentAddedByName,
  withEnvironmentReplaced
} from './runtime-environment-pairing-record'
import {
  createEnvironmentFromPairingOffer,
  PersistedRuntimeEnvironmentSchema
} from './runtime-environments'

const offer: PairingOffer = {
  v: 2,
  endpoint: 'ws://127.0.0.1:4000',
  deviceToken: 'token',
  publicKeyB64: Buffer.alloc(32, 3).toString('base64')
}

function persisted(id: string, name: string, now = 100) {
  return PersistedRuntimeEnvironmentSchema.parse(
    createEnvironmentFromPairingOffer({ id, name, now, offer, runtimeId: null })
  )
}

describe('pairing record pieces', () => {
  it('parses a pairing code or throws the caller’s message', () => {
    expect(parseLoopbackPairingCode(encodePairingOffer(offer), 'bad')).toMatchObject({
      endpoint: offer.endpoint
    })
    expect(() => parseLoopbackPairingCode('nope', 'Invalid X.')).toThrow('Invalid X.')
  })

  it('refuses a taken id before a taken name', () => {
    const known = [{ id: 'a', name: 'A' }]
    expect(() => assertNewEnvironmentIdAndName(known, 'a', 'A')).toThrow(
      'A server with id "a" already exists.'
    )
    expect(() => assertNewEnvironmentIdAndName(known, 'b', 'A')).toThrow(
      'A server named "A" already exists.'
    )
    expect(() => assertNewEnvironmentIdAndName(known, 'b', 'B')).not.toThrow()
  })

  it('compares every field a re-pair would change', () => {
    expect(isSamePairingOffer(offer, { ...offer })).toBe(true)
    for (const change of [
      { endpoint: 'ws://127.0.0.1:4001' },
      { deviceToken: 'other' },
      { publicKeyB64: Buffer.alloc(32, 4).toString('base64') },
      { pairedDeviceId: 'device' }
    ]) {
      expect(isSamePairingOffer(offer, { ...offer, ...change })).toBe(false)
    }
  })

  it('keeps identity and last use, and moves the revision forward even with an older clock', () => {
    const existing = { ...persisted('a', 'A'), pairingRevision: 500, lastUsedAt: 42 }
    const next = repairedPersistedEnvironment(existing, { ...offer, deviceToken: 'new' }, 300)
    expect(next).toMatchObject({
      id: 'a',
      name: 'A',
      createdAt: 100,
      updatedAt: 300,
      pairingRevision: 501,
      lastUsedAt: 42
    })
    expect(next.connectionDependency).toBeUndefined()
    expect(repairedPersistedEnvironment(existing, offer, 900, 'ssh-tunnel')).toMatchObject({
      pairingRevision: 900,
      connectionDependency: 'ssh-tunnel'
    })
  })

  it('adds sorted by name and replaces in place', () => {
    const b = persisted('b', 'Beta')
    const a = persisted('a', 'Alpha')
    expect(withEnvironmentAddedByName([b], a).map((entry) => entry.id)).toEqual(['a', 'b'])
    const renamed = { ...b, lastUsedAt: 7 }
    expect(withEnvironmentReplaced([a, b], renamed)).toEqual([a, renamed])
  })
})
