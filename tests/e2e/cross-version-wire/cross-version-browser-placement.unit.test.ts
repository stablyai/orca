import { beforeAll, describe, expect, it } from 'vitest'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { BrowserTabCreateParams } from '../../../src/main/runtime/rpc/methods/browser-tab-create-schema'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  type ReleaseCheckout
} from './release-checkout'

type Schema = { parse: (value: unknown) => Record<string, unknown> }

// This contract needs a release from before client placement shipped; a rolling
// stable baseline eventually contains every additive feature under test.
const LEGACY_BROWSER_PLACEMENT_RELEASE_REF = 'v1.4.184'

// v1.4.185 moved the tab-create schema and renamed it. Keeping both locations
// avoids coupling an intentional legacy-baseline bump to that unrelated refactor.
const BASELINE_TAB_CREATE_SOURCES = [
  ['browser-tab-create-schema.ts', 'BrowserTabCreateParams'],
  ['browser-schemas.ts', 'TabCreate']
] as const

async function importBaselineTabCreate(checkout: ReleaseCheckout): Promise<Schema> {
  const attempted: string[] = []
  for (const [file, exportName] of BASELINE_TAB_CREATE_SOURCES) {
    attempted.push(`${file}#${exportName}`)
    const loaded = await importReleaseCheckoutModule(
      checkout,
      `/src/main/runtime/rpc/methods/${file}`
    ).catch(() => null)
    const schema = loaded?.[exportName] as Schema | undefined
    if (schema?.parse) {
      return schema
    }
  }
  throw new Error(
    `Baseline release at ${checkout.root} exposes no tab-create schema (tried ${attempted.join(', ')}).`
  )
}

const legacyRequest = {
  url: 'https://example.test',
  worktree: 'id:worktree-a',
  profileId: 'profile-a',
  waitForRegistration: true,
  activate: true,
  targetGroupId: 'group-a'
}

let baselineRef: string
let baselineRevision: string
let baselineTabCreate: Schema
let baselineProtocol: Record<string, unknown>

beforeAll(async () => {
  baselineRef = LEGACY_BROWSER_PLACEMENT_RELEASE_REF
  const checkout = await materializeReleaseCheckout(baselineRef)
  baselineRevision = checkout.commit
  const [tabCreate, protocol] = await Promise.all([
    importBaselineTabCreate(checkout),
    importReleaseCheckoutModule(checkout, '/src/shared/protocol-version.ts')
  ])
  baselineTabCreate = tabCreate
  baselineProtocol = protocol
})

describe('cross-version browser placement', () => {
  it('loads a real stable release without client-host capabilities', () => {
    expect(baselineRef).toMatch(/^v\d/)
    expect(baselineRevision).toMatch(/^[0-9a-f]{40}$/)
    expect(baselineProtocol).not.toHaveProperty('BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY')
    expect(baselineProtocol).not.toHaveProperty('BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY')
    expect(BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY).toBe('browser.clientHost.v1')
    expect(BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY).toBe('network.browserTunnel.v1')
  })

  it('lets an old server ignore additive client placement', () => {
    expect(
      baselineTabCreate.parse({
        ...legacyRequest,
        placement: { kind: 'client', browserHostClientId: 'desktop-a' }
      })
    ).toEqual(legacyRequest)
  })

  it('lets a new server preserve an old request as server placement', () => {
    const parsed = BrowserTabCreateParams.parse(legacyRequest)

    expect(parsed).toEqual(legacyRequest)
    expect(parsed).not.toHaveProperty('placement')
  })
})
