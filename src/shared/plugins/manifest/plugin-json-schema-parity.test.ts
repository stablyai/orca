import { describe, expect, it } from 'vitest'
import { pluginCatalogJsonSchema, pluginManifestJsonSchema } from './plugin-json-schema'
import {
  catalogEntryFixture as entry,
  catalogFixture as catalog,
  compilePluginJsonSchema,
  descriptionAt,
  v2ManifestFixture as manifest
} from './plugin-json-schema.test-fixture'
import { parsePluginManifest } from './plugin-manifest'
import { pluginCatalogSchema } from '../catalog/plugin-catalog'

const manifestSchema = pluginManifestJsonSchema()
const catalogSchema = pluginCatalogJsonSchema()
const validateManifest = compilePluginJsonSchema(manifestSchema).validate
const validateCatalog = compilePluginJsonSchema(catalogSchema).validate

function runtimeAcceptsManifest(raw: unknown): boolean {
  return parsePluginManifest(raw).ok
}

/** v2 skips an entry it cannot parse, so "accepted" means every entry survived. */
function runtimeAcceptsCatalog(raw: { plugins: unknown[] }): boolean {
  const parsed = pluginCatalogSchema.safeParse(raw)
  return parsed.success && parsed.data.plugins.length === raw.plugins.length
}

const panel = { id: 'board', title: 'Board', entry: 'panel.html' }

describe('published schema and runtime agree on rejection', () => {
  it.each([
    ['an unknown key', { surprise: true }],
    ['a non-kebab id', { id: 'Not_Kebab' }],
    ['a traversing path', { icon: 'assets/../../secret.png' }],
    ['an absolute path', { icon: '/etc/passwd' }],
    [
      'too many panels',
      {
        execution: 'sandboxed-ui',
        contributes: { panels: Array.from({ length: 65 }, () => panel) }
      }
    ],
    ['a wrong-typed name', { name: 5 }],
    ['a wrong-typed contributes', { contributes: [] }],
    ['a range Orca cannot gate on', { engines: { orca: '^1.4.0' } }],
    ['an unknown execution profile', { execution: 'root' }],
    ['an unknown contribution point', { contributes: { widgets: [] } }],
    ['an http homepage', { homepage: 'http://example.com' }]
  ])('manifest with %s', (_label, overrides) => {
    const raw = manifest(overrides)
    expect(validateManifest(raw)).toBe(false)
    expect(runtimeAcceptsManifest(raw)).toBe(false)
  })

  it.each([
    ['no releases', entry({ releases: undefined })],
    ['only unreadable releases', entry({ releases: [{ version: '1.0.0' }] })],
    ['a short commit', entry({}, { commit: 'abc' })],
    ['an unknown contribution type', entry({}, { types: ['widget'] })],
    ['duplicate contribution types', entry({}, { types: ['syntax', 'syntax'] })],
    ['a non-git source', entry({ source: { kind: 'zip', url: 'https://x', ref: 'main' } })],
    ['an unqualified id', entry({ id: 'gleam-syntax' })]
  ])('catalog entry with %s', (_label, bad) => {
    const raw = catalog([JSON.parse(JSON.stringify(bad))])
    expect(validateCatalog(raw)).toBe(false)
    expect(runtimeAcceptsCatalog(raw)).toBe(false)
  })

  // Why tolerated: a catalog only lists, so the runtime keeps what it can and the published
  // schema (used by CI and editors) is where these are errors.
  it.each([
    ['duplicate categories', entry({ categories: ['syntax', 'syntax'] }), ['syntax']],
    ['a wrong-typed description', entry({ description: 5 }), undefined]
  ])('catalog entry with %s is an authoring error the runtime repairs', (_label, bad, kept) => {
    const raw = catalog([bad])
    expect(validateCatalog(raw)).toBe(false)
    const parsed = pluginCatalogSchema.parse(raw)
    expect(parsed.plugins).toHaveLength(1)
    if (kept) {
      expect(parsed.plugins[0]?.categories).toEqual(kept)
    } else {
      expect(parsed.plugins[0]?.description).toBeUndefined()
    }
  })

  it('catalog with too many plugins is trimmed at runtime and refused by the schema', () => {
    const raw = catalog(
      Array.from({ length: 2_049 }, (_, index) => entry({ id: `acme.p${index}` }))
    )
    expect(validateCatalog(raw)).toBe(false)
    expect(pluginCatalogSchema.parse(raw).plugins).toHaveLength(2_048)
  })

  it('catalog repeating an id keeps the first copy, as its description says', () => {
    const raw = catalog([entry({ description: 'first' }), entry({ description: 'second' })])
    expect(pluginCatalogSchema.parse(raw).plugins.map((plugin) => plugin.description)).toEqual([
      'first'
    ])
    expect(descriptionAt(catalogSchema, '/properties/plugins')).toContain('Orca keeps the first')
  })
})

/** Rules a JSON Schema cannot state, so only Orca enforces them. Each must be named in the
 *  description of the field an editor shows, so authors still learn the rule. Adding a runtime
 *  rule the schema misses means adding it here. */
const RUNTIME_ONLY_RULES = [
  {
    rule: 'reserved plugin ids',
    raw: manifest({ id: 'constructor' }),
    pointer: '/properties/id',
    phrase: 'reserved names'
  },
  {
    rule: 'reserved contribution ids',
    raw: manifest({
      execution: 'sandboxed-ui',
      contributes: { panels: [{ ...panel, id: 'prototype' }] }
    }),
    pointer: '/$defs/PanelContribution/properties/id',
    phrase: 'reserved names'
  },
  {
    rule: 'Windows device names in paths',
    raw: manifest({ icon: 'assets/CON/icon.png' }),
    pointer: '/properties/icon',
    phrase: 'Windows device names'
  },
  {
    rule: 'contributions beyond the execution profile',
    raw: manifest({ contributes: { panels: [panel] } }),
    pointer: '/properties/execution',
    phrase: 'Contributions beyond it fail validation'
  },
  {
    rule: 'duplicate contribution ids',
    raw: manifest({ execution: 'sandboxed-ui', contributes: { panels: [panel, panel] } }),
    pointer: '/$defs/PanelContribution/properties/id',
    phrase: 'unique'
  },
  {
    rule: 'duplicate locales, ignoring case',
    raw: manifest({
      contributes: {
        languagePacks: [
          { locale: 'pt-BR', path: 'a.json' },
          { locale: 'pt-br', path: 'b.json' }
        ]
      }
    }),
    pointer: '/$defs/LanguagePackContribution/properties/locale',
    phrase: 'ignoring case'
  },
  {
    rule: 'keybindings for commands the plugin does not contribute',
    raw: manifest({
      execution: 'declarative',
      contributes: { keybindings: [{ command: 'missing', key: 'Mod+K' }] }
    }),
    pointer: '/$defs/KeybindingContribution/properties/command',
    phrase: 'contributes.commands'
  },
  {
    rule: 'trusted-worker without a Node entry',
    raw: manifest({ execution: 'trusted-worker' }),
    pointer: '/properties/main',
    phrase: 'is required by it'
  },
  {
    rule: 'events without their domain capability',
    raw: manifest({
      execution: 'trusted-worker',
      main: 'main.mjs',
      contributes: { events: [{ on: 'workspace.created' }] }
    }),
    pointer: '/$defs/EventContribution',
    phrase: 'workspace:read'
  },
  {
    rule: 'catalog types beyond the execution profile',
    raw: catalog([entry({}, { types: ['panel'] })]),
    pointer: '/$defs/CatalogRelease/properties/types',
    phrase: 'needs `sandboxed-ui`'
  },
  {
    rule: 'reserved names in catalog ids',
    raw: catalog([entry({ id: 'acme.constructor' })]),
    pointer: '/$defs/CatalogEntry/properties/id',
    phrase: 'reserved names'
  },
  {
    rule: 'git URLs other than HTTPS or SSH',
    raw: catalog([entry({ source: { kind: 'git', url: 'file:///repo', ref: 'main' } })]),
    pointer: '/$defs/CatalogGitSource/properties/url',
    phrase: 'HTTPS or SSH'
  }
]

describe('runtime-only rules', () => {
  it.each(RUNTIME_ONLY_RULES)('$rule: schema allows, Orca refuses, docs say so', (rule) => {
    const isCatalog = 'plugins' in rule.raw
    const schema = isCatalog ? catalogSchema : manifestSchema
    const raw = JSON.parse(JSON.stringify(rule.raw))
    expect(isCatalog ? validateCatalog(raw) : validateManifest(raw)).toBe(true)
    expect(isCatalog ? runtimeAcceptsCatalog(raw) : runtimeAcceptsManifest(raw)).toBe(false)
    expect(descriptionAt(schema, rule.pointer)).toContain(rule.phrase)
  })
})

/** The compatibility policy, pinned: what runs is strict, what only lists is tolerant. */
describe('unknown-key policy', () => {
  it.each([
    ['the root', manifest({ future: true })],
    ['contributes', manifest({ contributes: { widgets: [] } })],
    [
      'a contribution',
      manifest({ contributes: { themes: [{ id: 'a', label: 'A', path: 'a.json', future: 1 }] } })
    ],
    ['engines', manifest({ engines: { orca: '>=9.0.0', node: '>=20' } })]
  ])('manifests reject an unknown key in %s', (_where, raw) => {
    expect(runtimeAcceptsManifest(raw)).toBe(false)
  })

  it('catalogs ignore unknown keys at every level', () => {
    const raw = catalog([
      entry(
        {
          future: true,
          source: { kind: 'git', url: 'https://github.com/acme/gleam.git', ref: 'main', future: 1 }
        },
        { future: 1 }
      )
    ])
    const parsed = pluginCatalogSchema.parse({ ...raw, future: { anything: true } })
    expect(parsed.plugins).toHaveLength(1)
    expect(JSON.stringify(parsed)).not.toContain('future')
  })
})
