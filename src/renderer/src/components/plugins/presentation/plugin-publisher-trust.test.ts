import { describe, expect, it } from 'vitest'
import { pluginManifestSchema } from '../../../../../shared/plugins/manifest/plugin-manifest'
import { isSafeContentOnlyPlugin, pluginPublisherNotice } from './plugin-publisher-trust'

function manifest(extra: Record<string, unknown>) {
  return pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'demo',
    publisher: 'someone',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    ...extra
  })
}

const theme = manifest({
  contributes: { themes: [{ id: 'dusk', label: 'Dusk', path: 'dusk.json' }] }
})

describe('isSafeContentOnlyPlugin', () => {
  it('is safe only for the verified data profile', () => {
    expect(isSafeContentOnlyPlugin({ execution: 'data' })).toBe(true)
    expect(isSafeContentOnlyPlugin({ execution: 'data', manifest: theme })).toBe(true)
    for (const execution of ['declarative', 'sandboxed-ui', 'trusted-worker'] as const) {
      expect(isSafeContentOnlyPlugin({ execution, manifest: theme })).toBe(false)
    }
  })

  it('is never safe while the profile is unknown', () => {
    expect(isSafeContentOnlyPlugin({ execution: null, manifest: theme })).toBe(false)
  })

  it.each([
    ['a worker', { main: 'worker.js' }],
    ['a capability', { capabilities: [{ kind: 'storage:own' }] }],
    [
      'commands',
      { contributes: { commands: [{ id: 'go', title: 'Go', action: 'sidebar.left.toggle' }] } }
    ]
  ])('re-derives from the manifest, so a data claim carrying %s is not safe', (_label, extra) => {
    expect(isSafeContentOnlyPlugin({ execution: 'data', manifest: manifest(extra) })).toBe(false)
  })
})

const languagePack = manifest({
  contributes: {
    languagePacks: [{ locale: 'de', path: 'de.json' }]
  }
})

describe('pluginPublisherNotice', () => {
  it.each([
    [true, 'data', 'none'],
    [true, 'trusted-worker', 'none'],
    [false, 'data', 'none'],
    [false, 'declarative', 'code'],
    [false, 'sandboxed-ui', 'code'],
    [false, 'trusted-worker', 'code'],
    [false, null, 'code']
  ] as const)('official %s, profile %s: %s', (official, execution, notice) => {
    expect(pluginPublisherNotice({ official, execution, types: ['app-theme'] })).toBe(notice)
  })

  it('keeps a one-line note for a community language pack, from its manifest or its types', () => {
    const community = { official: false, execution: 'data' as const }
    expect(pluginPublisherNotice({ ...community, manifest: languagePack, types: null })).toBe(
      'translations'
    )
    expect(pluginPublisherNotice({ ...community, types: ['interface-language'] })).toBe(
      'translations'
    )
    expect(pluginPublisherNotice({ ...community, manifest: theme, types: null })).toBe('none')
    // Why: nothing verified says it carries no translations yet.
    expect(pluginPublisherNotice({ ...community, types: null })).toBe('translations')
    expect(
      pluginPublisherNotice({ ...community, official: true, types: ['interface-language'] })
    ).toBe('none')
  })

  it('warns about code for a theme that also carries a panel', () => {
    expect(
      pluginPublisherNotice({
        official: false,
        execution: 'sandboxed-ui',
        types: ['app-theme', 'panel']
      })
    ).toBe('code')
  })
})
