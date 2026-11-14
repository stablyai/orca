import { describe, expect, it } from 'vitest'
import { PLUGIN_MANIFEST_V2_SINCE } from '../manifest/plugin-schema-field-docs'
import {
  pluginCatalogReleaseError,
  pluginCatalogReleaseSchema,
  type PluginCatalogRelease
} from './plugin-catalog-release'
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

describe('catalog releases', () => {
  it('drops only the summary items this client cannot read', () => {
    const parsed = pluginCatalogReleaseSchema.parse({
      ...release(),
      contributes: [
        { kind: 'panels', name: 'Dash' },
        { kind: 'futureEditors', name: 'Canvas', detail: '.canvas' }
      ]
    })
    expect(parsed.contributes).toEqual([{ kind: 'panels', name: 'Dash' }])
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

  it('accepts file types only when a syntax in the release handles them', () => {
    const syntaxManifest = manifest({
      contributes: {
        syntaxes: [
          {
            id: 'typ',
            title: 'Typst',
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
  })
})
