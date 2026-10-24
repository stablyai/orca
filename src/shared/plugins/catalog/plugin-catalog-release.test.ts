import { describe, expect, it } from 'vitest'
import { PLUGIN_MANIFEST_V2_SINCE } from '../manifest/plugin-schema-field-docs'
import {
  pluginCatalogReleaseEntry,
  pluginCatalogReleaseError,
  pluginCatalogReleaseSchema,
  type PluginCatalogRelease
} from './plugin-catalog-release'
import { pluginContributionSummary } from '../plugin-contribution-summary'
import { parsePluginManifest, type PluginManifest } from '../manifest/plugin-manifest'

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
    engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
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
    minimumOrca: PLUGIN_MANIFEST_V2_SINCE,
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
    engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` }
  }
}

describe('catalog releases', () => {
  it('accepts a release that matches the exact bytes and manifest', () => {
    expect(check(release())).toBeNull()
  })

  it.each([
    ['a language pack', {}],
    [
      'a worker with capabilities and a syntax',
      {
        execution: 'trusted-worker',
        main: 'main.mjs',
        capabilities: [{ kind: 'storage' }],
        contributes: {
          syntaxes: [
            {
              id: 'gleam',
              label: 'Gleam',
              scopeName: 'source.gleam',
              path: 'g.json',
              extensions: ['.gleam']
            }
          ]
        }
      }
    ]
  ])('builds a release entry for %s that install accepts as is', (_label, overrides) => {
    const subject = manifest(overrides)
    const entry = pluginCatalogReleaseEntry(subject, { commit: COMMIT, contentHash: HASH })
    expect(check(pluginCatalogReleaseSchema.parse(entry), subject)).toBeNull()
  })

  it('strips unknown optional fields instead of rejecting the release', () => {
    expect(pluginCatalogReleaseSchema.parse({ ...release(), futureField: 1 })).toEqual(release())
  })

  it('rejects a release type its profile cannot run or this client cannot install', () => {
    expect(() => release({ types: ['worker'] })).toThrow('data cannot declare worker')
    expect(
      pluginCatalogReleaseSchema.safeParse({ ...release(), types: ['file-viewer'] }).success
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

  it('accepts file types only when a syntax in the release handles them', () => {
    const syntaxManifest = manifest({
      contributes: {
        syntaxes: [
          {
            id: 'typ',
            label: 'Typst',
            scopeName: 'source.typst',
            path: 't.json',
            extensions: ['.Typ']
          }
        ]
      }
    })
    expect(check(release({ types: ['syntax'], fileTypes: ['typ'] }), syntaxManifest)).toBeNull()
    expect(check(release({ types: ['syntax'], fileTypes: ['typ', 'gleam'] }), syntaxManifest)).toBe(
      'file types do not match the catalog release'
    )
    // A newer catalog's odd entries are dropped instead of hiding the whole release.
    expect(
      pluginCatalogReleaseSchema.parse({
        ...release(),
        fileTypes: ['.typ', 'typ', 7, 'typ', ...Array.from({ length: 40 }, (_, i) => `t${i}`)]
      }).fileTypes
    ).toEqual(['typ', ...Array.from({ length: 31 }, (_, i) => `t${i}`)])
    expect(check(release({ types: ['syntax'], name: 'Other' }), syntaxManifest)).toBe(
      'plugin name does not match the catalog release'
    )
  })

  it('requires a v2 manifest', () => {
    const v1 = parsePluginManifest({
      ...manifestInput(),
      manifestVersion: 1,
      pluginApi: 1,
      execution: undefined
    })
    if (!v1.ok) {
      throw new Error(v1.error)
    }
    expect(check(release(), v1.manifest)).toContain('version 2 manifest')
  })
})

describe('catalog release summaries', () => {
  it('must match what the manifest adds and asks for', () => {
    const themed = manifest({
      contributes: { themes: [{ id: 'dusk', label: 'Dusk', path: 'dusk.json' }] },
      capabilities: []
    })
    const base = { manifest: themed, resolvedCommit: COMMIT, contentHash: HASH }
    const listed = release({ types: ['app-theme'] })
    expect(
      pluginCatalogReleaseError({
        ...base,
        release: { ...listed, contributes: pluginContributionSummary(themed), capabilities: [] }
      })
    ).toBeNull()
    expect(
      pluginCatalogReleaseError({
        ...base,
        release: { ...listed, contributes: [{ kind: 'themes', name: 'Midnight' }] }
      })
    ).toBe('the listed contributions do not match the catalog release')
    expect(
      pluginCatalogReleaseError({ ...base, release: { ...listed, capabilities: ['secrets'] } })
    ).toBe('the listed capabilities do not match the catalog release')
  })

  it('drops unreadable summaries and images instead of hiding the release', () => {
    const parsed = pluginCatalogReleaseSchema.parse({
      ...release(),
      contributes: [{ kind: 'widgets', name: 'x' }],
      capabilities: ['root'],
      images: {
        cover: { path: '../escape.png', alt: 'x', sha256: 'f'.repeat(64), width: 1, height: 1 }
      }
    })
    expect(parsed.contributes).toBeUndefined()
    expect(parsed.capabilities).toBeUndefined()
    expect(parsed.images).toBeUndefined()
  })
})

describe('catalog theme previews', () => {
  it('keeps hex palettes and drops anything else', () => {
    const palette = {
      label: 'Dusk',
      base: 'dark',
      background: '#1b1430',
      foreground: '#e8e0ff',
      accent: '#c38bff',
      surface: '#241843'
    }
    expect(
      pluginCatalogReleaseSchema.parse({ ...release(), themePreview: [palette] }).themePreview
    ).toEqual([palette])
    expect(
      pluginCatalogReleaseSchema.parse({
        ...release(),
        themePreview: [{ ...palette, background: 'url(https://example.com/x)' }]
      }).themePreview
    ).toBeUndefined()
  })
})
