import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  PAIRING_OFFER_TUNNEL_VERSION,
  PAIRING_OFFER_VERSION,
  PairingOfferSchema,
  type PairingOffer,
  type PairingTunnel
} from './mobile-relay-pairing-offer'
import { decodePairingOffer, encodePairingOffer } from './pairing'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  removeEnvironment,
  updateEnvironmentFromPairingCode
} from './runtime-environment-store'
import { createEnvironmentFromPairingOffer, getPreferredPairingOffer } from './runtime-environments'
import {
  getRemoteRuntimeTunnelDialer,
  setRemoteRuntimeTunnelDialer
} from './remote-runtime-tunnel-dialer'

const tunnel: PairingTunnel = {
  v: 1,
  kind: 'tailcat',
  token:
    'tco2FwWCBNNXephjfh0aPdFjAU60bmk0dsn6pXpyS18lQ6Y7CUHmFrWCAU3RvbevDi9OlgUzXuM3IjdmvnmzoRvViPRDNnZQBnLmFpGQEu',
  port: 6768
}

const baseOffer: PairingOffer = {
  v: PAIRING_OFFER_VERSION,
  endpoint: 'ws://127.0.0.1:6768',
  deviceToken: 'device-token',
  publicKeyB64: `${'a'.repeat(43)}=`,
  scope: 'runtime' as const
}
const LegacyStoreSchema = z.object({ version: z.literal(1), environments: z.array(z.unknown()) })
function decodePairingCodeBase64(url: string): string {
  return new URL(url).searchParams.get('code')!.replace(/-/g, '+').replace(/_/g, '/')
}
const tunnelOffer: PairingOffer = { ...baseOffer, v: PAIRING_OFFER_TUNNEL_VERSION, tunnel }
// Why: what every pre-tunnel Orca accepts; it must refuse a tunnel offer outright, never strip it.
const LegacyPairingOfferSchema = z.object({
  v: z.literal(2),
  endpoint: z.string(),
  deviceToken: z.string(),
  publicKeyB64: z.string(),
  scope: z.enum(['mobile', 'runtime']).optional()
})

describe('pairing offer tunnel block', () => {
  it('accepts a tailcat tunnel for runtime and mobile scope', () => {
    for (const scope of ['runtime', 'mobile'] as const) {
      const parsed = PairingOfferSchema.parse({ ...tunnelOffer, scope })
      expect(parsed.tunnel).toEqual(tunnel)
    }
  })

  it('ties the tunnel to pairing version 3 in both directions', () => {
    expect(PairingOfferSchema.safeParse({ ...baseOffer, tunnel }).success).toBe(false)
    expect(PairingOfferSchema.safeParse({ ...baseOffer, v: 3 }).success).toBe(false)
  })

  it('is refused, not stripped, by clients that predate tunnels', () => {
    const encoded = JSON.parse(
      Buffer.from(decodePairingCodeBase64(encodePairingOffer(tunnelOffer)), 'base64').toString(
        'utf8'
      )
    ) as unknown
    expect(LegacyPairingOfferSchema.safeParse(encoded).success).toBe(false)
    expect(LegacyPairingOfferSchema.safeParse(baseOffer).success).toBe(true)
  })

  it('round-trips through the pairing URL', () => {
    const url = encodePairingOffer(tunnelOffer)
    expect(decodePairingOffer(url)).toMatchObject({ v: PAIRING_OFFER_TUNNEL_VERSION, tunnel })
  })

  it.each([
    ['not an address blob', { ...tunnel, token: 'abc123' }],
    ['a blob with a space', { ...tunnel, token: 'tc abc' }],
    ['a blob longer than a SOCKS5 domain', { ...tunnel, token: `tc${'a'.repeat(254)}` }],
    ['an unknown kind', { ...tunnel, kind: 'wireguard' }],
    ['port zero', { ...tunnel, port: 0 }],
    ['a port out of range', { ...tunnel, port: 70000 }]
  ])('rejects %s', (_name, invalid) => {
    expect(PairingOfferSchema.safeParse({ ...tunnelOffer, tunnel: invalid }).success).toBe(false)
  })

  it('is optional so older hosts keep parsing', () => {
    expect(PairingOfferSchema.parse(baseOffer)).not.toHaveProperty('tunnel')
  })
})

describe('runtime environments with a tunnel', () => {
  it('keeps the tunnel on the saved endpoint and restores it into the preferred offer', () => {
    const environment = createEnvironmentFromPairingOffer({
      id: 'env-1',
      name: 'Tunnel host',
      now: 1,
      offer: tunnelOffer
    })
    expect(environment.endpoints[0]?.tunnel).toEqual(tunnel)
    expect(getPreferredPairingOffer(environment)).toMatchObject({
      v: PAIRING_OFFER_TUNNEL_VERSION,
      tunnel
    })
  })

  it('records a tailcat connection dependency when adding from a tunnel pairing code', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-tunnel-env-'))
    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'Tunnel host',
      pairingCode: encodePairingOffer(tunnelOffer)
    })
    expect(environment.connectionDependency).toBe('tailcat')
  })

  it('writes store version 2 only while a tunnel endpoint exists, so old builds refuse it', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-tunnel-env-'))
    const storePath = getEnvironmentStorePath(userDataPath)
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'Plain host',
      pairingCode: encodePairingOffer({ ...baseOffer, endpoint: 'ws://100.64.1.20:6768' })
    })
    expect(JSON.parse(readFileSync(storePath, 'utf8')).version).toBe(1)
    const tunnelled = addEnvironmentFromPairingCode(userDataPath, {
      name: 'Tunnel host',
      pairingCode: encodePairingOffer(tunnelOffer)
    })
    const raw = JSON.parse(readFileSync(storePath, 'utf8')) as { version: number }
    expect(raw.version).toBe(2)
    // Why: a pre-tunnel build parses version 1 only; it must fail closed instead of stripping and rewriting.
    expect(LegacyStoreSchema.safeParse(raw).success).toBe(false)
    removeEnvironment(userDataPath, tunnelled.id)
    expect(JSON.parse(readFileSync(storePath, 'utf8')).version).toBe(1)
  })

  it('carries unknown endpoint fields through a read-modify-write', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-tunnel-env-'))
    const storePath = getEnvironmentStorePath(userDataPath)
    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'Future host',
      pairingCode: encodePairingOffer({ ...baseOffer, endpoint: 'ws://100.64.1.20:6768' })
    })
    const raw = JSON.parse(readFileSync(storePath, 'utf8')) as {
      environments: { endpoints: Record<string, unknown>[] }[]
    }
    raw.environments[0]!.endpoints[0]!.futureTransport = { v: 9 }
    writeFileSync(storePath, JSON.stringify(raw))
    updateEnvironmentFromPairingCode(userDataPath, environment.id, {
      pairingCode: encodePairingOffer({ ...baseOffer, endpoint: 'ws://100.64.1.21:6768' })
    })
    const rewritten = JSON.parse(readFileSync(storePath, 'utf8')) as typeof raw
    expect(rewritten.environments[0]!.endpoints[0]!.endpoint).toBe('ws://100.64.1.21:6768')
    expect(listEnvironments(userDataPath)[0]?.endpoints[0]).toMatchObject({
      endpoint: 'ws://100.64.1.21:6768'
    })
  })

  it('never records tailcat for an offer without a tunnel', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-tunnel-env-'))
    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'Plain host',
      pairingCode: encodePairingOffer({ ...baseOffer, endpoint: 'ws://100.64.1.20:6768' }),
      connectionDependency: 'tailcat'
    })
    expect(environment).not.toHaveProperty('connectionDependency')
  })
})

describe('remote runtime tunnel dialer registry', () => {
  afterEach(() => {
    setRemoteRuntimeTunnelDialer(null)
  })

  it('is empty until a host registers a dialer', () => {
    expect(getRemoteRuntimeTunnelDialer()).toBeNull()
    const dialer = async (): Promise<never> => {
      throw new Error('unused')
    }
    setRemoteRuntimeTunnelDialer(dialer)
    expect(getRemoteRuntimeTunnelDialer()).toBe(dialer)
  })
})
