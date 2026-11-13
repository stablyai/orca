import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../manifest/plugin-manifest'

function manifest(
  panels: unknown[],
  capabilities: unknown[] = [{ kind: 'settings:own' }],
  floor = '1.4.258'
) {
  return {
    manifestVersion: 2,
    id: 'tasks',
    publisher: 'acme',
    name: 'Tasks',
    version: '1.0.0',
    engines: { orca: `>=${floor}` },
    execution: 'sandboxed-ui',
    pluginApi: 1,
    contributes: { panels },
    capabilities
  }
}
const connection = {
  id: 'connection',
  title: 'Task connection',
  entry: 'connection.tsx',
  ui: 'components',
  location: 'settings'
}

describe('plugin integration settings panels', () => {
  it('requires explicit source development opt-in for unreleased settings panels', () => {
    expect(parsePluginManifest(manifest([connection]))).toMatchObject({ ok: false })
    expect(parsePluginManifest({ ...manifest([connection]), manifestVersion: 1 })).toMatchObject({
      ok: false
    })
    expect(
      parsePluginManifest(
        manifest([{ id: 'tasks', title: 'Tasks', entry: 'tasks.html' }, connection]),
        { allowUnreleased: true }
      )
    ).toMatchObject({
      ok: true,
      manifest: {
        contributes: {
          panels: [{ id: 'tasks' }, { id: 'connection', ui: 'components', location: 'settings' }]
        }
      }
    })
  })

  it('retains released engine floors, components-only UI, uniqueness and own-settings access', () => {
    for (const input of [
      manifest([connection], [{ kind: 'settings:own' }], '1.4.245'),
      manifest([{ ...connection, ui: 'html', entry: 'connection.html' }]),
      manifest([connection, { ...connection, id: 'other' }]),
      manifest([connection], [])
    ]) {
      expect(parsePluginManifest(input, { allowUnreleased: true }).ok).toBe(false)
    }
  })
})
