import { describe, expect, it } from 'vitest'
import { PLUGIN_MANIFEST_V2_SINCE } from './manifest/plugin-schema-field-docs'
import { pluginCatalogReleaseSchema } from './catalog/plugin-catalog-release'
import { parsePluginManifest } from './manifest/plugin-manifest'

const release = {
  version: '1.2.0',
  commit: 'c'.repeat(40),
  contentHash: 'f'.repeat(64),
  execution: 'data',
  minimumOrca: '1.4.0',
  types: ['interface-language']
}

function v2Manifest(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    manifestVersion: 2,
    execution: 'data',
    id: 'demo',
    publisher: 'acme',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
    ...overrides
  }
}

describe('plugin detail fields', () => {
  it('keeps valid catalog release details', () => {
    const details = {
      license: 'Apache-2.0 OR MIT',
      repository: 'https://github.com/acme/demo',
      homepage: 'https://example.com/demo',
      updatedAt: '2026-10-20T09:30:00Z',
      changelog: 'Adds Portuguese.'
    }
    expect(pluginCatalogReleaseSchema.parse({ ...release, ...details })).toMatchObject(details)
    expect(pluginCatalogReleaseSchema.parse({ ...release, updatedAt: '2026-10-20' })).toMatchObject(
      { updatedAt: '2026-10-20' }
    )
  })

  it('drops invalid catalog release details instead of hiding the release', () => {
    const parsed = pluginCatalogReleaseSchema.parse({
      ...release,
      license: 'MIT; rm -rf',
      repository: 'http://github.com/acme/demo',
      homepage: 'javascript:alert(1)',
      updatedAt: 'last week',
      changelog: 'x'.repeat(2_001)
    })
    expect(parsed.license).toBeUndefined()
    expect(parsed.repository).toBeUndefined()
    expect(parsed.homepage).toBeUndefined()
    expect(parsed.updatedAt).toBeUndefined()
    expect(parsed.changelog).toBeUndefined()
  })

  it('validates manifest license and homepage', () => {
    expect(
      parsePluginManifest(v2Manifest({ license: 'MIT', homepage: 'https://example.com' }))
    ).toMatchObject({ ok: true, manifest: { license: 'MIT', homepage: 'https://example.com' } })
    expect(parsePluginManifest(v2Manifest({ homepage: 'http://example.com' }))).toEqual({
      ok: false,
      error: 'homepage: must be an https URL'
    })
    expect(parsePluginManifest(v2Manifest({ license: 'MIT license' }))).toEqual({
      ok: false,
      error: 'license: must be an SPDX expression'
    })
  })
})
