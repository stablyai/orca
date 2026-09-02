import { describe, expect, it } from 'vitest'
import {
  PLUGIN_COMMAND_LIMIT,
  PLUGIN_ID_MAX_LENGTH,
  parsePluginManifest,
  pluginManifestSchema
} from './plugin-manifest'

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'demo',
    publisher: 'orca-samples',
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
