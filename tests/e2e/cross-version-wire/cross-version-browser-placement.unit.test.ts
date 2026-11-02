import { beforeAll, describe, expect, it } from 'vitest'
import { BrowserTabCreateParams } from '../../../src/shared/rpc-contract/browser-tab-create-params'
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
let baselineTabCreate: Schema

beforeAll(async () => {
  baselineRef = LEGACY_BROWSER_PLACEMENT_RELEASE_REF
  const checkout = await materializeReleaseCheckout(baselineRef)
  const tabCreate = await importBaselineTabCreate(checkout)
  baselineTabCreate = tabCreate
})

describe('cross-version browser placement', () => {
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
