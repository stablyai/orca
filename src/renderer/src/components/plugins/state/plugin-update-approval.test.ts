import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api/plugins/plugin-host-api'
import {
  pluginManifestSchema,
  type PluginManifest
} from '../../../../../shared/plugins/manifest/plugin-manifest'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn() } }))

const { installUpdates } = await import('./plugin-update-approval')
const { toast } = await import('sonner')

function previewFor(
  pluginKey: string,
  manifest: PluginManifest,
  official: boolean
): PluginMarketplaceHostInstallPreview {
  return {
    marketplaceSourceId: 'official',
    marketplaceName: 'Orca Plugins',
    marketplaceOwner: 'stablyai',
    marketplaceCommit: 'c',
    pluginKey,
    source: { kind: 'git', url: 'https://github.com/acme/plugin.git', ref: 'v1' },
    resolvedCommit: 'r',
    contentHash: 'h',
    consentFingerprint: `reviewed-${pluginKey}`,
    manifest,
    official,
    bundled: false
  }
}

const manifest = pluginManifestSchema.parse({
  manifestVersion: 2,
  id: 'plugin',
  publisher: 'acme',
  name: 'Plugin',
  version: '2.0.0',
  execution: 'data',
  license: 'MIT',
  engines: { orca: '>=1.4.248' },
  capabilities: [],
  contributes: {}
})
const preview = (pluginKey: string): PluginMarketplaceHostInstallPreview =>
  previewFor(pluginKey, manifest, true)

function stubApi(
  installed: Record<string, { ok: boolean; consentFingerprint?: string; error?: string }>
) {
  const consent = vi.fn(async () => [])
  vi.stubGlobal('window', {
    api: {
      plugins: {
        installMarketplacePlugin: vi.fn(
          async ({ pluginKey }: { pluginKey: string }) => installed[pluginKey]
        ),
        consent
      }
    }
  })
  return consent
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('installUpdates', () => {
  it('preserves landed updates and separates unattempted rows after a catalog timeout', async () => {
    stubApi({
      'acme.done': { ok: true, consentFingerprint: 'reviewed-acme.done' },
      'acme.waiting': {
        ok: false,
        error: 'The plugin catalog is still updating. Try again in a moment.'
      }
    })
    const result = await installUpdates(
      ['acme.done', 'acme.waiting', 'acme.later'].map((key) => ({
        preview: preview(key),
        name: key,
        reviewed: true
      }))
    )
    expect(result.approved.map((item) => item.name)).toEqual(['acme.done'])
    expect(result.failed.map((item) => item.name)).toEqual(['acme.waiting'])
    expect(result).toMatchObject({
      error: 'The plugin catalog is still updating. Try again in a moment.',
      unattempted: [{ name: 'acme.later' }]
    })
    expect(window.api.plugins.installMarketplacePlugin).toHaveBeenCalledTimes(2)
  })
  it('approves exactly the reviewed fingerprint and holds bytes that changed after review', async () => {
    const consent = stubApi({
      'acme.same': { ok: true, consentFingerprint: 'reviewed-acme.same' },
      'acme.changed': { ok: true, consentFingerprint: 'other' },
      'acme.broken': { ok: false }
    })
    const result = await installUpdates(
      ['acme.same', 'acme.changed', 'acme.broken'].map((key) => ({
        preview: preview(key),
        name: key,
        reviewed: true
      }))
    )
    expect(result.approved.map(({ name }) => name)).toEqual(['acme.same'])
    expect(result.held.map(({ name }) => name)).toEqual(['acme.changed'])
    expect(result.failed.map(({ name }) => name)).toEqual(['acme.broken'])
    expect(consent).toHaveBeenCalledTimes(1)
    expect(consent).toHaveBeenCalledWith({
      pluginKey: 'acme.same',
      reviewedFingerprint: 'reviewed-acme.same',
      decision: 'approve'
    })
    expect(toast.warning).toHaveBeenCalledTimes(1)
  })

  it('installs an update that asks for nothing new without approving anything', async () => {
    const consent = stubApi({ 'acme.plain': { ok: true, consentFingerprint: 'whatever' } })
    const result = await installUpdates([
      { preview: preview('acme.plain'), name: 'acme.plain', reviewed: false }
    ])
    expect(result.approved).toHaveLength(1)
    expect(consent).not.toHaveBeenCalled()
  })
})
