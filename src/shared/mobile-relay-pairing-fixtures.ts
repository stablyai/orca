import type { PairingOffer } from './pairing'

const PUBLIC_KEY_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const INVITE_TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678'

export type PairingFixture = {
  name: string
  payload: unknown
  expected: PairingOffer | null
}

export function createMobileRelayPairingFixtures(now: number): PairingFixture[] {
  const directOffer: PairingOffer = {
    v: 2,
    endpoint: 'ws://192.168.1.10:6768',
    deviceToken: 'device-token',
    publicKeyB64: PUBLIC_KEY_B64
  }
  const relay = {
    v: 1 as const,
    directorUrl: 'https://relay.onorca.dev',
    cellUrl: 'https://relay-c1.onorca.dev',
    assignmentEpoch: 7,
    relayHostId: 'AbCdEf0123_-xyZ9',
    inviteToken: INVITE_TOKEN,
    inviteExpiresAt: now + 5 * 60 * 1000,
    e2eeFraming: 2 as const
  }
  return [
    { name: 'legacy direct offer', payload: directOffer, expected: directOffer },
    {
      name: 'legacy direct offer with mobile scope',
      payload: { ...directOffer, scope: 'mobile' },
      expected: { ...directOffer, scope: 'mobile' }
    },
    {
      name: 'relay offer with absent scope',
      payload: { ...directOffer, relay },
      expected: { ...directOffer, relay }
    },
    {
      name: 'relay offer with mobile scope',
      payload: { ...directOffer, scope: 'mobile', relay },
      expected: { ...directOffer, scope: 'mobile', relay }
    },
    {
      name: 'unknown keys are stripped at both levels',
      payload: { ...directOffer, ignored: true, relay: { ...relay, ignored: true } },
      expected: { ...directOffer, relay }
    },
    {
      name: 'offer-level endpoints are stripped',
      payload: { ...directOffer, endpoints: [{ kind: 'relay' }] },
      expected: directOffer
    },
    {
      name: 'runtime relay is invalid',
      payload: { ...directOffer, scope: 'runtime', relay },
      expected: null
    },
    {
      name: 'relay offer public key must be canonical 32-byte base64',
      payload: { ...directOffer, publicKeyB64: 'legacy-nonempty-key', relay },
      expected: null
    },
    {
      name: 'non-canonical director origin is invalid',
      payload: { ...directOffer, relay: { ...relay, directorUrl: 'https://relay.onorca.dev/' } },
      expected: null
    },
    {
      name: 'non-HTTPS cell origin is invalid',
      payload: { ...directOffer, relay: { ...relay, cellUrl: 'http://relay-c1.onorca.dev' } },
      expected: null
    },
    {
      name: 'fractional assignment epoch is invalid',
      payload: { ...directOffer, relay: { ...relay, assignmentEpoch: 1.5 } },
      expected: null
    },
    {
      name: 'negative assignment epoch is invalid',
      payload: { ...directOffer, relay: { ...relay, assignmentEpoch: -1 } },
      expected: null
    },
    {
      name: 'unsafe assignment epoch is invalid',
      payload: {
        ...directOffer,
        relay: { ...relay, assignmentEpoch: Number.MAX_SAFE_INTEGER + 1 }
      },
      expected: null
    },
    {
      name: 'relay host id length is invalid',
      payload: { ...directOffer, relay: { ...relay, relayHostId: 'short' } },
      expected: null
    },
    {
      name: 'invite token length is invalid',
      payload: { ...directOffer, relay: { ...relay, inviteToken: 'short' } },
      expected: null
    },
    {
      name: 'expired invite is invalid',
      payload: { ...directOffer, relay: { ...relay, inviteExpiresAt: now } },
      expected: null
    },
    {
      name: 'invite beyond ten minutes is invalid',
      payload: { ...directOffer, relay: { ...relay, inviteExpiresAt: now + 10 * 60 * 1000 + 1 } },
      expected: null
    },
    {
      name: 'unsupported E2EE framing is invalid',
      payload: { ...directOffer, relay: { ...relay, e2eeFraming: 1 } },
      expected: null
    }
  ]
}

export function encodePairingFixturePayload(payload: unknown): string {
  const json = JSON.stringify(payload)
  const code = Buffer.from(json, 'utf8').toString('base64url')
  return `orca://pair?code=${code}`
}
