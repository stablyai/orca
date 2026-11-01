import { describe, expect, it } from 'vitest'
import { PLUGIN_MANIFEST_V2_SINCE } from '../manifest/plugin-schema-field-docs'
import { parsePluginManifest } from '../manifest/plugin-manifest'

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

describe('execution profiles', () => {
  it('rejects v2 contributions beyond the declared profile', () => {
    const parsed = parsePluginManifest({
      ...manifestInput(),
      execution: 'data',
      contributes: { commands: [{ id: 'open', title: 'Open', action: 'view.tasks' }] }
    })
    expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining('execution') })
  })
})
