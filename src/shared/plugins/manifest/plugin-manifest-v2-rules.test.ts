import { describe, expect, it } from 'vitest'

import { parseHostPluginManifest, parsePluginManifest } from './plugin-manifest'
import { PLUGIN_MANIFEST_V2_SINCE } from './plugin-schema-field-docs'

function v2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

describe('manifest format 2 rules', () => {
  it('skips only the engines floor when reading a manifest at runtime', () => {
    const underDeclared = v2({ engines: { orca: '>=1.4.160' } })
    expect(parseHostPluginManifest(underDeclared)).toMatchObject({ ok: true })
    expect(parsePluginManifest(underDeclared)).toMatchObject({ ok: false })
    // Every other rule still applies.
    expect(parseHostPluginManifest(v2({ engines: { orca: '>=1.4.160' }, pluginApi: 1 }))).toEqual({
      ok: false,
      error: 'pluginApi: data plugins never call the host API; remove pluginApi'
    })
  })
})
