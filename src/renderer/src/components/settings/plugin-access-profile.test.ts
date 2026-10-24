import { describe, expect, it } from 'vitest'
import { pluginManifestSchema } from '../../../../shared/plugins/plugin-manifest'
import { pluginConsentTier, pluginPageExecutionProfile } from './plugin-access-profile'

const commandManifest = pluginManifestSchema.parse({
  manifestVersion: 1,
  id: 'shortcuts',
  publisher: 'acme',
  name: 'Shortcuts',
  version: '1.0.0',
  engines: { orca: '>=1.0.0' },
  pluginApi: 1,
  contributes: {
    commands: [{ id: 'toggle', title: 'Toggle', action: 'sidebar.left.toggle' }]
  }
})

const listEntry = {
  hasWorker: false,
  commands: [],
  vmRecipes: [],
  panels: [],
  capabilities: []
}

describe('pluginPageExecutionProfile', () => {
  it('uses the release profile for a listed plugin, not the absence of a worker', () => {
    expect(
      pluginPageExecutionProfile({
        installed: null,
        installedManifest: undefined,
        listing: {
          release: {
            version: '1.0.0',
            commit: 'a'.repeat(40),
            contentHash: 'b'.repeat(64),
            execution: 'instructional',
            minimumOrca: '1.0.0',
            types: ['instructions']
          }
        },
        previewManifest: null
      })
    ).toBe('instructional')
  })

  it('derives from the fetched manifest when the catalog has no release record', () => {
    expect(
      pluginPageExecutionProfile({
        installed: null,
        installedManifest: undefined,
        listing: { release: undefined },
        previewManifest: commandManifest
      })
    ).toBe('instructional')
  })

  it('is unknown until something verified says otherwise', () => {
    expect(
      pluginPageExecutionProfile({
        installed: null,
        installedManifest: undefined,
        listing: { release: undefined },
        previewManifest: null
      })
    ).toBeNull()
    expect(
      pluginPageExecutionProfile({
        installed: {},
        installedManifest: undefined,
        listing: null,
        previewManifest: null
      })
    ).toBeNull()
  })

  it('reads the installed manifest when an older host omits the profile', () => {
    expect(
      pluginPageExecutionProfile({
        installed: {},
        installedManifest: commandManifest,
        listing: null,
        previewManifest: null
      })
    ).toBe('instructional')
  })
})

describe('pluginConsentTier', () => {
  it('follows the installed profile', () => {
    expect(pluginConsentTier({ ...listEntry, execution: 'instructional' })).toBe('instructional')
    expect(pluginConsentTier({ ...listEntry, execution: 'data' })).toBe('declarative')
    expect(pluginConsentTier({ ...listEntry, execution: 'trusted-worker' })).toBe('worker')
  })

  it('never calls an unknown profile content only', () => {
    expect(pluginConsentTier(listEntry)).toBe('instructional')
  })
})
