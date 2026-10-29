import { describe, expect, it } from 'vitest'
import { PLUGIN_MANIFEST_V2_SINCE } from './plugin-schema-field-docs'
import {
  PLUGIN_COMMAND_LIMIT,
  PLUGIN_ID_MAX_LENGTH,
  parsePluginManifest,
  pluginManifestSchema,
  satisfiesOrcaEngineRange
} from './plugin-manifest'

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'demo',
    publisher: 'samples',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: { panels: [], commands: [], events: [] },
    capabilities: [],
    ...overrides
  }
}

describe('pluginManifestSchema boundaries', () => {
  it('reads format 1 names as their renamed successors', () => {
    const result = parsePluginManifest(
      manifest({
        main: 'main.mjs',
        contributes: {
          commands: [{ id: 'run', title: 'Run', context: 'worktree' }],
          keybindings: [{ command: 'run', key: 'Mod+Shift+R', when: 'worktree' }],
          events: [{ on: 'worktree.created' }],
          themes: [{ id: 'dusk', label: 'Dusk', path: 'dusk.json' }],
          syntaxes: [{ id: 'g', label: 'G', scopeName: 'source.g', path: 'g.json' }],
          customEditors: [{ id: 'd', title: 'D', fileTypes: ['draw'], entry: 'd.html' }]
        },
        capabilities: [{ kind: 'storage' }, { kind: 'secrets' }, { kind: 'events:subscribe' }]
      })
    )

    expect(result).toMatchObject({
      ok: true,
      manifest: {
        contributes: {
          commands: [{ when: 'workspace' }],
          keybindings: [{ when: 'workspace' }],
          events: [{ on: 'workspace.created' }],
          themes: [{ title: 'Dusk' }],
          syntaxes: [{ title: 'G' }],
          customEditors: [{ extensions: ['.draw'] }]
        },
        capabilities: [
          { kind: 'storage:own' },
          { kind: 'secrets:own' },
          { kind: 'workspace:read' },
          { kind: 'agent:read' }
        ]
      }
    })
  })

  it('refuses format 1 names in format 2', () => {
    const result = parsePluginManifest({
      ...manifest({ capabilities: [{ kind: 'storage' }] }),
      manifestVersion: 2,
      execution: 'data',
      engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` }
    })

    expect(result.ok).toBe(false)
  })

  it('accepts documented dotted command namespaces with camel-case actions', () => {
    const result = parsePluginManifest(
      manifest({
        main: 'main.mjs',
        contributes: {
          panels: [],
          commands: [{ id: 'jupyter.restartKernel', title: 'Restart kernel' }],
          events: []
        }
      })
    )

    expect(result).toMatchObject({ ok: true })
  })

  it('rejects oversized identities and invalid semantic versions', () => {
    expect(parsePluginManifest(manifest({ id: 'a'.repeat(PLUGIN_ID_MAX_LENGTH + 1) })).ok).toBe(
      false
    )
    expect(parsePluginManifest(manifest({ version: '01.0.0' })).ok).toBe(false)
    expect(parsePluginManifest(manifest({ version: '1.0' })).ok).toBe(false)
    expect(parsePluginManifest(manifest({ version: '1.0.0-01' })).ok).toBe(false)
    expect(parsePluginManifest(manifest({ version: '1.0.0-alpha.1+build.5' })).ok).toBe(true)
  })

  it('reports one specific issue per bad id or path', () => {
    const reserved = pluginManifestSchema.safeParse(manifest({ id: 'constructor' }))
    expect(reserved.error?.issues.map((issue) => issue.message)).toEqual([
      'must not be a reserved name'
    ])
    const badPath = pluginManifestSchema.safeParse(manifest({ main: '../escape.js' }))
    expect(badPath.error?.issues).toHaveLength(1)
    const device = pluginManifestSchema.safeParse(manifest({ main: 'dist/CON.js' }))
    expect(device.error?.issues).toHaveLength(1)
  })

  it('accepts a $schema URL in v2 manifests only as an ignored hint', () => {
    const $schema = 'https://example.com/orca-plugin.schema.json'
    const v2 = parsePluginManifest(
      manifest({
        manifestVersion: 2,
        execution: 'data',
        contributes: {},
        pluginApi: undefined,
        engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
        $schema
      })
    )
    expect(v2).toMatchObject({ ok: true, manifest: { $schema } })
    expect(parsePluginManifest(manifest({ $schema }))).toMatchObject({ ok: true })
  })

  it('rejects duplicate contribution ids', () => {
    const parsed = pluginManifestSchema.safeParse(
      manifest({
        main: 'main.mjs',
        contributes: {
          panels: [
            { id: 'dashboard', title: 'One', entry: 'one.html' },
            { id: 'dashboard', title: 'Two', entry: 'two.html' }
          ],
          commands: [
            { id: 'run', title: 'One' },
            { id: 'run', title: 'Two' }
          ],
          events: []
        }
      })
    )

    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining(['duplicate panels id: dashboard', 'duplicate commands id: run'])
      )
    }
  })

  it('caps contribution arrays before they reach renderer or worker registries', () => {
    const commands = Array.from({ length: PLUGIN_COMMAND_LIMIT + 1 }, (_, index) => ({
      id: `command-${index}`,
      title: `Command ${index}`
    }))
    expect(
      parsePluginManifest(
        manifest({
          main: 'main.mjs',
          contributes: { panels: [], commands, events: [] }
        })
      ).ok
    ).toBe(false)
  })
})

describe('satisfiesOrcaEngineRange', () => {
  it.each([
    ['1.5.0', '>=1.5.0', true],
    ['1.5.1', '>=1.5.0', true],
    ['1.4.9', '>=1.5.0', false],
    ['1.5.0-rc.1', '>=1.5.0', false],
    ['1.5.1-rc.1', '>=1.5.0', true],
    ['1.5.0+build.7', '>=1.5.0', true],
    ['1.5.0+build-7', '>=1.5.0', true]
  ])('%s against %s is %s', (host, range, expected) => {
    expect(satisfiesOrcaEngineRange(host, range)).toBe(expected)
  })
})
