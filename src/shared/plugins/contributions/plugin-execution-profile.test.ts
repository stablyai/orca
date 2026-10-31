import { describe, expect, it } from 'vitest'
import { PLUGIN_MANIFEST_V2_SINCE } from '../manifest/plugin-schema-field-docs'
import { derivePluginExecutionProfile } from './plugin-execution-profile'
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
  const empty = {
    panels: [],
    commands: [],
    events: [],
    keybindings: [],
    vmRecipes: [],
    agentHarnesses: []
  }
  it.each([
    [{ main: 'main.mjs' }, {}, 'trusted-worker'],
    [{}, { panels: [{}] }, 'sandboxed-ui'],
    [{}, { commands: [{}] }, 'declarative'],
    [{}, { vmRecipes: [{}] }, 'declarative'],
    [{}, {}, 'data']
  ])('infers the least profile for a v1 manifest', (top, contributes, expected) => {
    expect(
      derivePluginExecutionProfile({
        capabilities: [],
        ...top,
        contributes: { ...empty, ...contributes }
      })
    ).toBe(expected)
  })

  it('rejects v2 contributions beyond the declared profile', () => {
    const parsed = parsePluginManifest({
      ...manifestInput(),
      execution: 'data',
      contributes: { commands: [{ id: 'open', title: 'Open', action: 'view.tasks' }] }
    })
    expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining('execution') })
  })

  it('requires a Node entry for trusted-worker and rejects unknown v2 keys', () => {
    expect(parsePluginManifest({ ...manifestInput(), execution: 'trusted-worker' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('main')
    })
    expect(parsePluginManifest({ ...manifestInput(), surprise: true })).toMatchObject({ ok: false })
  })

  it('keeps v1 manifests valid without a declared profile', () => {
    expect(
      parsePluginManifest({ ...manifestInput(), manifestVersion: 1, pluginApi: 1 })
    ).toMatchObject({
      ok: true
    })
  })
})
