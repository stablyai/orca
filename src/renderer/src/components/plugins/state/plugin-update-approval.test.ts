import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api/plugins/plugin-host-api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn() } }))

const { installUpdates } = await import('./plugin-update-approval')
const { toast } = await import('sonner')

const preview = (pluginKey: string): PluginMarketplaceHostInstallPreview =>
  ({
    pluginKey,
    marketplaceSourceId: 'official',
    marketplaceCommit: 'c',
    resolvedCommit: 'r',
    consentFingerprint: `reviewed-${pluginKey}`,
    manifest: { version: '2.0.0' }
  }) as PluginMarketplaceHostInstallPreview

function stubApi(installed: Record<string, { ok: boolean; consentFingerprint?: string }>) {
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
