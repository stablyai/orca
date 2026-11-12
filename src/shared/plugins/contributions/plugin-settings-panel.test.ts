import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../manifest/plugin-manifest'

function manifest(
  panels: unknown[],
  capabilities: unknown[] = [{ kind: 'settings:own' }],
  floor = '1.4.255'
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
  it('accepts a dedicated settings panel alongside a normal sidebar panel', () => {
    expect(
      parsePluginManifest(
        manifest([{ id: 'tasks', title: 'Tasks', entry: 'tasks.html' }, connection])
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

  it('refuses unsupported hosts, HTML, multiple settings pages and missing own-settings access', () => {
    for (const input of [
      manifest([connection], [{ kind: 'settings:own' }], '1.4.254'),
      manifest([{ ...connection, ui: 'html', entry: 'connection.html' }]),
      manifest([connection, { ...connection, id: 'other' }]),
      manifest([connection], [])
    ]) {
      expect(parsePluginManifest(input).ok).toBe(false)
    }
  })
})
