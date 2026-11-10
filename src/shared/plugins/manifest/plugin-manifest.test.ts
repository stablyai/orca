import { describe, expect, it } from 'vitest'
import { PLUGIN_MANIFEST_V2_SINCE, PLUGIN_PANEL_PLACEMENT_SINCE } from './plugin-schema-field-docs'
import {
  PLUGIN_COMMAND_LIMIT,
  parseHostPluginManifest,
  parsePluginManifest,
  pluginManifestSchema
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
  it('gates placement in legacy format without raising its other field floors', () => {
    const panel = { id: 'p', title: 'P', entry: 'panel.html', placement: 'left-navigation' }
    expect(parsePluginManifest(manifest({ contributes: { panels: [panel] } }))).toEqual({
      ok: false,
      error: `engines.orca: must be at least >=${PLUGIN_PANEL_PLACEMENT_SINCE}, because contributes.panels[0].placement needs Orca ${PLUGIN_PANEL_PLACEMENT_SINCE}`
    })
    expect(
      parsePluginManifest(
        manifest({
          engines: { orca: `>=${PLUGIN_PANEL_PLACEMENT_SINCE}` },
          contributes: { panels: [panel] }
        })
      )
    ).toMatchObject({ ok: true })
    expect(parseHostPluginManifest(manifest({ contributes: { panels: [panel] } }))).toMatchObject({
      ok: true
    })
  })
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
