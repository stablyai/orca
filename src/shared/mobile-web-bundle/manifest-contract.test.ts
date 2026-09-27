import { describe, expect, it } from 'vitest'
import { sha256 } from '../sha256'
import {
  computeMobileWebBundleId,
  serializeMobileWebBundleAssets,
  MobileWebBundleManifestSchema,
  MOBILE_WEB_BUNDLE_ENTRYPOINT,
  MOBILE_WEB_BUNDLE_MAX_ASSETS,
  MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES,
  MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS,
  MOBILE_WEB_BUNDLE_MAX_ROUTES,
  MOBILE_WEB_BUNDLE_MAX_TOTAL_BYTES,
  MOBILE_WEB_BUNDLE_SCHEMA_VERSION,
  type MobileWebBundleAsset
} from './manifest-contract'

function hexDigest(input: string): string {
  return Array.from(sha256(new TextEncoder().encode(input)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

function asset(path: string, byteLength: number): MobileWebBundleAsset {
  return {
    path,
    sha256: hexDigest(path),
    byteLength,
    contentType: path.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript'
  }
}

const ENTRY = asset(MOBILE_WEB_BUNDLE_ENTRYPOINT, 64)

function manifestOf(
  assets: readonly MobileWebBundleAsset[],
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const sorted = [...assets].sort((left, right) => (left.path < right.path ? -1 : 1))
  return {
    schemaVersion: MOBILE_WEB_BUNDLE_SCHEMA_VERSION,
    buildId: computeMobileWebBundleId(sorted),
    desktopVersion: '1.4.200',
    minCompatibleRuntimeProtocolVersion: 3,
    runtimeProtocolVersion: 3,
    entrypoint: MOBILE_WEB_BUNDLE_ENTRYPOINT,
    totalBytes: sorted.reduce((sum, entry) => sum + entry.byteLength, 0),
    assets: sorted,
    routes: [],
    ...overrides
  }
}

function assetsTotalling(count: number, totalBytes: number): MobileWebBundleAsset[] {
  const others = Array.from({ length: count - 1 }, (_, index) =>
    asset(`assets/${String(index).padStart(3, '0')}.js`, 0)
  )
  return [{ ...ENTRY, byteLength: totalBytes }, ...others]
}

describe('serializeMobileWebBundleAssets', () => {
  const assets = [ENTRY, asset('assets/a.js', 10), asset('assets/b.js', 20)]

  it('is stable under reordered input', () => {
    const reversed = assets.toReversed()
    const rotated = [assets[1], assets[2], assets[0]]
    expect(serializeMobileWebBundleAssets(reversed)).toBe(serializeMobileWebBundleAssets(assets))
    expect(computeMobileWebBundleId(rotated)).toBe(computeMobileWebBundleId(assets))
    expect(computeMobileWebBundleId(reversed)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('serializes in path order with a fixed key order', () => {
    expect(serializeMobileWebBundleAssets(assets.toReversed())).toBe(
      JSON.stringify([assets[1], assets[2], assets[0]])
    )
  })

  it('changes the id when any hashed field changes', () => {
    const base = computeMobileWebBundleId(assets)
    expect(computeMobileWebBundleId([...assets.slice(1), { ...ENTRY, byteLength: 65 }])).not.toBe(
      base
    )
    expect(
      computeMobileWebBundleId([...assets.slice(1), { ...ENTRY, contentType: 'text/plain' }])
    ).not.toBe(base)
    expect(computeMobileWebBundleId(assets.slice(1))).not.toBe(base)
  })
})

describe('MobileWebBundleManifestSchema', () => {
  it('accepts a well-formed manifest', () => {
    expect(MobileWebBundleManifestSchema.safeParse(manifestOf([ENTRY])).success).toBe(true)
  })

  it('rejects an unknown key', () => {
    expect(
      MobileWebBundleManifestSchema.safeParse(manifestOf([ENTRY], { bridge: {} })).success
    ).toBe(false)
  })

  it('rejects another schema version', () => {
    expect(
      MobileWebBundleManifestSchema.safeParse(manifestOf([ENTRY], { schemaVersion: 2 })).success
    ).toBe(false)
  })
})

describe('the page routes a manifest declares', () => {
  function withRoutes(routes: unknown): boolean {
    return MobileWebBundleManifestSchema.safeParse(manifestOf([ENTRY], { routes })).success
  }

  it('accepts a route pattern with its grants, and one with none', () => {
    expect(withRoutes([{ pathname: '/h/[hostId]', grants: ['navigate'] }])).toBe(true)
    expect(withRoutes([{ pathname: '/h/[hostId]/tasks', grants: [] }])).toBe(true)
  })

  it('refuses a pathname a phone could not write into its own history', () => {
    // Each of these reaches `history.replaceState` on the phone, where `//host` throws a
    // cross-origin SecurityError and a query or a fragment is a second field pasted into the first.
    for (const pathname of [
      'h/[hostId]',
      '//evil.example/h',
      '/\\evil.example',
      '/h?x=1',
      '/h#t'
    ]) {
      expect(withRoutes([{ pathname, grants: [] }]), pathname).toBe(false)
    }
  })

  it('refuses a grant name that is not one', () => {
    // One segment under `native` is not a verb: the namespace is `native.<domain>.<action>`, and
    // anything shorter is a plain name wearing a dot.
    expect(withRoutes([{ pathname: '/h', grants: ['native.navigate'] }])).toBe(false)
    expect(withRoutes([{ pathname: '/h', grants: [''] }])).toBe(false)
    for (const grant of ['navigate.', '.native', 'native..read', 'Native.Clipboard.Read', 'a.b']) {
      expect(withRoutes([{ pathname: '/h', grants: [grant] }]), grant).toBe(false)
    }
  })

  it('takes a native verb, which a route must be able to declare to ever be granted one', () => {
    // Without this no manifest can name a verb, and with per-route grants that leaves every native
    // verb unreachable for every route.
    for (const grant of [
      'native.clipboard.write',
      'native.clipboard.read',
      'native.file.pick',
      'native.a.b.c'
    ]) {
      expect(withRoutes([{ pathname: '/h', grants: [grant] }]), grant).toBe(true)
    }
  })

  /** The first plain grant added since this pattern was written, and the reason its name has no
   *  dot: one segment under `native` is refused as a malformed verb, so a capability that is not a
   *  verb has to be a single token. */
  it('takes the binary screencast lane, and refuses the spelling that looks like a verb', () => {
    expect(withRoutes([{ pathname: '/h', grants: ['screencastBinary'] }])).toBe(true)
    expect(withRoutes([{ pathname: '/h', grants: ['native.screencast'] }])).toBe(false)
    expect(withRoutes([{ pathname: '/h', grants: ['browser.screencast'] }])).toBe(false)
  })

  it('refuses a route carrying a field the contract does not declare', () => {
    expect(withRoutes([{ pathname: '/h', grants: [], screen: 'x' }])).toBe(false)
  })

  /**
   * The optional lane (ruling 37), held to the required lane's own rules.
   *
   * One grammar, because the shell filters both lists against one implemented set and the page reads
   * one `grants.native`: a name only one lane could carry would be a second vocabulary, which is
   * what candidate A was rejected for. One ceiling over the union, because the union is what a
   * session's granted list is built from.
   */
  it('takes an optional grant list, absent or empty, under the same grammar', () => {
    expect(withRoutes([{ pathname: '/h', grants: ['navigate'], optionalGrants: [] }])).toBe(true)
    expect(
      withRoutes([{ pathname: '/h', grants: ['navigate'], optionalGrants: ['screencastBinary'] }])
    ).toBe(true)
    expect(
      withRoutes([
        { pathname: '/h', grants: ['navigate'], optionalGrants: ['native.clipboard.write'] }
      ])
    ).toBe(true)
    // The spellings the required lane refuses, refused here too.
    expect(
      withRoutes([{ pathname: '/h', grants: [], optionalGrants: ['native.screencast'] }])
    ).toBe(false)
    expect(withRoutes([{ pathname: '/h', grants: [], optionalGrants: [''] }])).toBe(false)
  })

  it('bounds the two lists together, not one at a time', () => {
    const names = (count, prefix) =>
      Array.from({ length: count }, (_value, index) => `${prefix}${String(index)}`)
    const half = MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS / 2
    // At the ceiling exactly, split across the lanes.
    expect(
      withRoutes([
        { pathname: '/h', grants: names(half, 'req'), optionalGrants: names(half, 'opt') }
      ])
    ).toBe(true)
    // One past it, with neither lane over the ceiling on its own: this is the case a per-array
    // ceiling passes and a page would be handed twice what the cap bounds.
    expect(
      withRoutes([
        { pathname: '/h', grants: names(half + 1, 'req'), optionalGrants: names(half, 'opt') }
      ])
    ).toBe(false)
    // And the per-array ceiling still holds on its own, so the union check is not the only fence.
    expect(
      withRoutes([
        {
          pathname: '/h',
          grants: [],
          optionalGrants: names(MOBILE_WEB_BUNDLE_MAX_ROUTE_GRANTS + 1, 'opt')
        }
      ])
    ).toBe(false)
  })

  it('requires the field, so a bundle cannot leave the shell guessing', () => {
    const manifest = manifestOf([ENTRY])
    Reflect.deleteProperty(manifest, 'routes')
    expect(MobileWebBundleManifestSchema.safeParse(manifest).success).toBe(false)
  })

  it('leaves the build id alone, because the assets already decide the routes', () => {
    const withoutRoutes = MobileWebBundleManifestSchema.parse(manifestOf([ENTRY]))
    const withOne = MobileWebBundleManifestSchema.parse(
      manifestOf([ENTRY], { routes: [{ pathname: '/h/[hostId]', grants: ['navigate'] }] })
    )
    expect(withOne.buildId).toBe(withoutRoutes.buildId)
  })

  it('accepts the route ceiling and refuses one past it', () => {
    const routes = Array.from({ length: MOBILE_WEB_BUNDLE_MAX_ROUTES }, (_value, index) => ({
      pathname: `/h/${String(index)}`,
      grants: []
    }))
    expect(withRoutes(routes)).toBe(true)
    expect(withRoutes([...routes, { pathname: '/h/extra', grants: [] }])).toBe(false)
  })
})

describe('contract ceilings', () => {
  it('accepts the asset count ceiling and rejects one past it', () => {
    const atCeiling = assetsTotalling(MOBILE_WEB_BUNDLE_MAX_ASSETS, 64)
    expect(MobileWebBundleManifestSchema.safeParse(manifestOf(atCeiling)).success).toBe(true)
    const overCeiling = [...atCeiling, asset('assets/overflow.js', 0)]
    expect(overCeiling).toHaveLength(MOBILE_WEB_BUNDLE_MAX_ASSETS + 1)
    expect(MobileWebBundleManifestSchema.safeParse(manifestOf(overCeiling)).success).toBe(false)
  })

  it('accepts the per-asset ceiling and rejects one byte past it', () => {
    const atCeiling = [{ ...ENTRY, byteLength: MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES }]
    expect(MobileWebBundleManifestSchema.safeParse(manifestOf(atCeiling)).success).toBe(true)
    const overCeiling = [{ ...ENTRY, byteLength: MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES + 1 }]
    expect(MobileWebBundleManifestSchema.safeParse(manifestOf(overCeiling)).success).toBe(false)
  })

  it('accepts the total ceiling and rejects one byte past it', () => {
    const perAsset = MOBILE_WEB_BUNDLE_MAX_TOTAL_BYTES / 4
    const atCeiling = [
      { ...ENTRY, byteLength: perAsset },
      asset('assets/a.js', perAsset),
      asset('assets/b.js', perAsset),
      asset('assets/c.js', perAsset)
    ]
    expect(MobileWebBundleManifestSchema.safeParse(manifestOf(atCeiling)).success).toBe(true)
    const overCeiling = [...atCeiling.slice(1), { ...ENTRY, byteLength: perAsset + 1 }]
    expect(MobileWebBundleManifestSchema.safeParse(manifestOf(overCeiling)).success).toBe(false)
  })
})

describe('manifest invariants', () => {
  const twoAssets = [ENTRY, asset('assets/a.js', 10)]

  it('rejects an unsorted or duplicated asset list', () => {
    const reversed = [...twoAssets].sort((left, right) => (left.path < right.path ? 1 : -1))
    expect(
      MobileWebBundleManifestSchema.safeParse(manifestOf(twoAssets, { assets: reversed })).success
    ).toBe(false)
    expect(
      MobileWebBundleManifestSchema.safeParse(manifestOf(twoAssets, { assets: [ENTRY, ENTRY] }))
        .success
    ).toBe(false)
  })

  it('rejects a totalBytes that disagrees with the asset sum', () => {
    expect(
      MobileWebBundleManifestSchema.safeParse(manifestOf(twoAssets, { totalBytes: 0 })).success
    ).toBe(false)
    expect(
      MobileWebBundleManifestSchema.safeParse(manifestOf(twoAssets, { totalBytes: 75 })).success
    ).toBe(false)
  })

  it('rejects a manifest whose entrypoint is not listed', () => {
    expect(
      MobileWebBundleManifestSchema.safeParse(manifestOf([asset('assets/a.js', 10)])).success
    ).toBe(false)
  })

  it('rejects paths that collide when case is folded', () => {
    const parsed = MobileWebBundleManifestSchema.safeParse(
      manifestOf([ENTRY, asset('assets/A.js', 10), asset('assets/a.js', 10)])
    )
    expect(parsed.success).toBe(false)
    // Both sort strictly ascending, so it must be the fold check that fires, not the order check.
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      'asset paths must not collide when case is folded'
    ])
  })

  it('rejects a buildId that is not the content hash of the assets', () => {
    expect(
      MobileWebBundleManifestSchema.safeParse(manifestOf(twoAssets, { buildId: 'f'.repeat(64) }))
        .success
    ).toBe(false)
    // A stale id: correct for a previous asset list, so only the recomputation catches it.
    expect(
      MobileWebBundleManifestSchema.safeParse(
        manifestOf(twoAssets, { buildId: computeMobileWebBundleId([ENTRY]) })
      ).success
    ).toBe(false)
  })

  it('rejects an inverted protocol window', () => {
    expect(
      MobileWebBundleManifestSchema.safeParse(
        manifestOf(twoAssets, { minCompatibleRuntimeProtocolVersion: 4 })
      ).success
    ).toBe(false)
  })
})

describe('refinement short-circuit', () => {
  const WRONG_BUILD_ID = 'f'.repeat(64)

  function issuePaths(manifest: Record<string, unknown>): string[] {
    const parsed = MobileWebBundleManifestSchema.safeParse(manifest)
    expect(parsed.success).toBe(false)
    return (parsed.error?.issues ?? []).map((issue) => issue.path.join('.'))
  }

  it('reports buildId when every cheaper invariant holds', () => {
    const withinCeiling = assetsTotalling(MOBILE_WEB_BUNDLE_MAX_ASSETS, 64)
    expect(issuePaths(manifestOf(withinCeiling, { buildId: WRONG_BUILD_ID }))).toEqual(['buildId'])
  })

  it('does not hash an oversized asset list', () => {
    const overCeiling = [
      ...assetsTotalling(MOBILE_WEB_BUNDLE_MAX_ASSETS, 64),
      asset('assets/overflow.js', 0)
    ]
    const paths = issuePaths(manifestOf(overCeiling, { buildId: WRONG_BUILD_ID }))
    expect(paths).toEqual(['assets'])
    expect(paths).not.toContain('buildId')
  })

  it('does not hash once a cheaper invariant has failed', () => {
    const twoAssets = [ENTRY, asset('assets/a.js', 10)]
    expect(issuePaths(manifestOf(twoAssets, { totalBytes: 0, buildId: WRONG_BUILD_ID }))).toEqual([
      'totalBytes'
    ])
    expect(
      issuePaths(
        manifestOf(twoAssets, {
          minCompatibleRuntimeProtocolVersion: 4,
          buildId: WRONG_BUILD_ID
        })
      )
    ).toEqual(['minCompatibleRuntimeProtocolVersion'])
  })
})

describe('asset paths', () => {
  it.each([
    '../escape.js',
    'assets/../../escape.js',
    '/absolute.js',
    'assets\\escape.js',
    'a/./b.js',
    'assets/nul.js',
    'assets/CON',
    'assets/lpt1.js',
    'assets/foo.',
    'assets/...'
  ])('rejects %s', (path) => {
    const parsed = MobileWebBundleManifestSchema.safeParse(
      manifestOf([ENTRY, { ...asset('assets/a.js', 10), path }])
    )
    expect(parsed.success).toBe(false)
  })

  it('accepts exactly one spelling of a parameterised content type', () => {
    expect(
      MobileWebBundleManifestSchema.safeParse(
        manifestOf([{ ...ENTRY, contentType: 'text/html; charset=utf-8' }])
      ).success
    ).toBe(true)
    // A2's builder emits the single-space form; the other spellings are the same bytes under a
    // different build id.
    for (const contentType of ['text/html;charset=utf-8', 'text/html;  charset=utf-8']) {
      expect(
        MobileWebBundleManifestSchema.safeParse(manifestOf([{ ...ENTRY, contentType }])).success
      ).toBe(false)
    }
  })

  it('rejects an uppercase content type, which would give the same bytes two ids', () => {
    for (const contentType of ['Text/HTML; charset=utf-8', 'text/JavaScript', 'TEXT/PLAIN']) {
      expect(
        MobileWebBundleManifestSchema.safeParse(
          manifestOf([ENTRY, { ...asset('assets/a.js', 10), contentType }])
        ).success
      ).toBe(false)
    }
  })

  it('rejects a malformed sha256 or content type', () => {
    expect(
      MobileWebBundleManifestSchema.safeParse(
        manifestOf([ENTRY, { ...asset('assets/a.js', 10), sha256: 'AB'.repeat(32) }])
      ).success
    ).toBe(false)
    expect(
      MobileWebBundleManifestSchema.safeParse(
        manifestOf([ENTRY, { ...asset('assets/a.js', 10), contentType: 'nope' }])
      ).success
    ).toBe(false)
  })
})
