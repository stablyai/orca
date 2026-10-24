import { describe, expect, it } from 'vitest'
import {
  pluginCatalogReleaseError,
  pluginCatalogReleaseSchema,
  type PluginCatalogRelease
} from './plugin-catalog-release'
import { parsePluginManifest, type PluginManifest } from './plugin-manifest'

const COMMIT = 'c'.repeat(40)
const HASH = 'f'.repeat(64)

function manifest(overrides: Record<string, unknown> = {}): PluginManifest {
  const parsed = parsePluginManifest({
    manifestVersion: 2,
    execution: 'data',
    id: 'demo',
    publisher: 'samples',
    name: 'Demo',
    version: '1.2.0',
    engines: { orca: '>=1.4.0' },
    pluginApi: 1,
    contributes: { languagePacks: [{ locale: 'pt-BR', path: 'pt.json' }] },
    ...overrides
  })
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  return parsed.manifest
}

function release(overrides: Partial<PluginCatalogRelease> = {}): PluginCatalogRelease {
  return pluginCatalogReleaseSchema.parse({
    version: '1.2.0',
    commit: COMMIT,
    contentHash: HASH,
    execution: 'data',
    minimumOrca: '1.4.0',
    types: ['interface-language'],
    ...overrides
  })
}

function check(record: PluginCatalogRelease, subject = manifest()): string | null {
  return pluginCatalogReleaseError({
    release: record,
    manifest: subject,
    resolvedCommit: COMMIT,
    contentHash: HASH
  })
}

function manifestInput(): Record<string, unknown> {
  return {
    manifestVersion: 2,
    execution: 'data',
    id: 'demo',
    publisher: 'samples',
    name: 'Demo',
    version: '1.2.0',
    engines: { orca: '>=1.4.0' },
    pluginApi: 1
  }
}

describe('catalog releases', () => {
  it('accepts a release that matches the exact bytes and manifest', () => {
    expect(check(release())).toBeNull()
  })

  it('strips unknown optional fields instead of rejecting the release', () => {
    expect(pluginCatalogReleaseSchema.parse({ ...release(), futureField: 1 })).toEqual(release())
  })

  it('rejects a release type its profile cannot run or this client cannot install', () => {
    expect(() => release({ types: ['worker'] })).toThrow('data cannot declare worker')
    expect(
      pluginCatalogReleaseSchema.safeParse({ ...release(), types: ['icon-theme'] }).success
    ).toBe(false)
  })

  it.each([
    ['commit', { resolvedCommit: 'd'.repeat(40) }, 'commit'],
    ['bytes', { contentHash: 'e'.repeat(64) }, 'bytes']
  ])('rejects a changed %s', (_label, override, message) => {
    expect(
      pluginCatalogReleaseError({
        release: release(),
        manifest: manifest(),
        resolvedCommit: COMMIT,
        contentHash: HASH,
        ...override
      })
    ).toContain(message)
  })

  it.each([
    ['version', release({ version: '1.3.0' }), 'version'],
    ['profile', release({ execution: 'instructional' }), 'execution profile'],
    ['compatibility', release({ minimumOrca: '1.5.0' }), 'compatibility']
  ])('rejects a manifest whose %s differs from the release', (_label, record, message) => {
    expect(check(record)).toContain(message)
  })

  it('rejects declared contributions the manifest does not carry', () => {
    const record = release({
      execution: 'instructional',
      types: ['interface-language', 'instructions']
    })
    expect(check(record, manifest({ execution: 'instructional' }))).toContain('contributions')
  })

  it('requires a v2 manifest', () => {
    const v1 = parsePluginManifest({ ...manifestInput(), manifestVersion: 1, execution: undefined })
    if (!v1.ok) {
      throw new Error(v1.error)
    }
    expect(check(release(), v1.manifest)).toContain('version 2 manifest')
  })
})
