import { afterEach, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../../../../shared/plugins/manifest/plugin-manifest'
import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api/plugins/plugin-host-api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn() } }))
const { installUpdates } = await import('./plugin-update-approval')
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('keeps a successfully published update out of failed installs when consent is refused', async () => {
  const preview: PluginMarketplaceHostInstallPreview = {
    marketplaceSourceId: 'a'.repeat(32),
    marketplaceName: 'Samples',
    marketplaceOwner: 'samples',
    marketplaceCommit: 'c'.repeat(40),
    pluginKey: 'samples.demo',
    source: { kind: 'git', url: 'https://github.com/samples/demo.git', ref: 'main' },
    resolvedCommit: 'b'.repeat(40),
    contentHash: 'b'.repeat(64),
    consentFingerprint: 'reviewed',
    official: false,
    bundled: false,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 2,
      id: 'demo',
      publisher: 'samples',
      name: 'Demo',
      version: '1.1.0',
      execution: 'data',
      license: 'MIT',
      engines: { orca: '>=1.4.248' },
      capabilities: [],
      contributes: {}
    })
  }
  vi.stubGlobal('window', {
    api: {
      plugins: {
        installMarketplacePlugin: vi.fn(async () => ({ ok: true, consentFingerprint: 'reviewed' })),
        consent: vi.fn(async () => {
          throw new Error('marketplace changed after preview; review the plugin again')
        })
      }
    }
  })
  const result = await installUpdates([{ preview, name: 'Demo', reviewed: true }])
  expect(result.held.map((item) => item.preview.pluginKey)).toEqual(['samples.demo'])
  expect(result.failed).toEqual([])
  expect(result.approved).toEqual([])
  expect(window.api.plugins.installMarketplacePlugin).toHaveBeenCalledTimes(1)
})
