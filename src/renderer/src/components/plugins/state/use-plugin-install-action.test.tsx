// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing
} from '../../../../../preload/api-types'
import { pluginManifestSchema } from '../../../../../shared/plugins/manifest/plugin-manifest'
import { usePluginInstallAction } from './use-plugin-install-action'

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('./plugin-theme-apply', () => ({ applyPluginThemesNow: vi.fn() }))
import { toast, type ExternalToast } from 'sonner'
import { applyPluginThemesNow } from './plugin-theme-apply'

const listing: PluginMarketplaceHostListing = {
  marketplaceSourceId: 'source',
  marketplaceName: 'Catalog',
  marketplaceOwner: 'acme',
  marketplaceCommit: 'b'.repeat(40),
  pluginKey: 'acme.dusk',
  source: { kind: 'git', url: 'https://example.invalid/dusk.git', ref: 'main' },
  categories: [],
  official: false,
  bundled: false,
  release: {
    version: '1.0.0',
    commit: 'c'.repeat(40),
    contentHash: 'd'.repeat(64),
    execution: 'data',
    minimumOrca: '1.0.0',
    types: ['app-theme']
  }
}

const preview: PluginMarketplaceHostInstallPreview = {
  ...listing,
  resolvedCommit: 'c'.repeat(40),
  contentHash: 'd'.repeat(64),
  consentFingerprint: 'sha256-shown',
  manifest: pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'dusk',
    publisher: 'acme',
    name: 'Dusk',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: { themes: [{ id: 'dusk', label: 'Dusk', path: 'themes/dusk.json' }] }
  })
}

const codePreview: PluginMarketplaceHostInstallPreview = {
  ...preview,
  manifest: pluginManifestSchema.parse({
    ...preview.manifest,
    contributes: { commands: [{ id: 'go', title: 'Go', action: 'sidebar.left.toggle' }] }
  })
}

function setup() {
  const onTryPlugin = vi.fn()
  const onInstalled = vi.fn().mockResolvedValue(undefined)
  const fetchPreview = vi.fn().mockResolvedValue({ ok: true, preview })
  const hook: { current: ReturnType<typeof usePluginInstallAction> | null } = { current: null }
  function Probe(): null {
    hook.current = usePluginInstallAction({ fetchPreview, onInstalled, onTryPlugin })
    return null
  }
  act(() => createRoot(document.createElement('div')).render(<Probe />))
  return { hook, onInstalled, onTryPlugin, fetchPreview }
}

function installResult(on: boolean) {
  return {
    ok: true as const,
    pluginKey: listing.pluginKey,
    version: '1.0.0',
    contentHash: 'd'.repeat(64),
    consentFingerprint: 'sha256-shown',
    resolvedCommit: 'c'.repeat(40),
    needsReview: !on
  }
}

beforeEach(() => {
  vi.mocked(toast.success).mockClear()
  vi.mocked(applyPluginThemesNow).mockReset().mockResolvedValue(false)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plugins: {
        installMarketplacePlugin: vi.fn().mockResolvedValue(installResult(true)),
        consent: vi.fn().mockResolvedValue([])
      }
    }
  })
})

/** Clicks a sonner toast action through a real button, as the toast would. */
function clickToastAction(options: ExternalToast | undefined): void {
  const action = options?.action
  if (!action || typeof action !== 'object' || !('onClick' in action)) {
    return
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => root.render(createElement('button', { onClick: action.onClick })))
  act(() => container.querySelector('button')?.click())
  act(() => root.unmount())
}

describe('usePluginInstallAction', () => {
  it('asks main to turn on a content-only release and leaves nothing pending after', async () => {
    const { hook, onInstalled } = setup()
    await act(async () => hook.current?.install(listing))
    // Why the fingerprint: main turns on only the bytes this preview showed.
    expect(window.api.plugins.installMarketplacePlugin).toHaveBeenCalledWith(
      expect.objectContaining({ enableIfData: true, expectedFingerprint: 'sha256-shown' })
    )
    expect(window.api.plugins.consent).not.toHaveBeenCalled()
    expect(onInstalled).toHaveBeenCalledWith(listing.pluginKey)
    expect(hook.current?.phaseOf(listing.pluginKey)).toBeNull()
  })

  it('applies a theme the user just installed, and its own toast replaces Try it', async () => {
    vi.mocked(applyPluginThemesNow).mockResolvedValue(true)
    const { hook } = setup()
    await act(async () => hook.current?.install(listing))
    expect(applyPluginThemesNow).toHaveBeenCalledExactlyOnceWith(listing.pluginKey)
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('applies no theme for a plugin that adds none', async () => {
    const { hook } = setup()
    const codeListing = {
      ...listing,
      release: { ...listing.release!, execution: 'instructional' as const }
    }
    vi.mocked(window.api.plugins.installMarketplacePlugin).mockResolvedValue(installResult(false))
    await act(async () => hook.current?.install(codeListing, { preview: codePreview }))
    expect(window.api.plugins.consent).toHaveBeenCalled()
    expect(applyPluginThemesNow).not.toHaveBeenCalled()
  })

  it('offers Try it after a successful card install', async () => {
    const { hook, onTryPlugin } = setup()
    await act(async () => hook.current?.install(listing))
    expect(toast.success).toHaveBeenCalledWith('Dusk installed', {
      action: { label: 'Try it', onClick: expect.any(Function) }
    })
    clickToastAction(vi.mocked(toast.success).mock.calls[0]?.[1])
    expect(onTryPlugin).toHaveBeenCalledWith(listing.pluginKey)
  })

  it('approves exactly the fingerprint the page showed for a plugin that runs code', async () => {
    const { hook } = setup()
    const codeListing = {
      ...listing,
      release: { ...listing.release!, execution: 'instructional' as const }
    }
    vi.mocked(window.api.plugins.installMarketplacePlugin).mockResolvedValue(installResult(false))
    await act(async () => hook.current?.install(codeListing, { preview: codePreview }))
    expect(window.api.plugins.installMarketplacePlugin).toHaveBeenCalledWith(
      expect.not.objectContaining({ enableIfData: true })
    )
    expect(window.api.plugins.consent).toHaveBeenCalledWith({
      pluginKey: listing.pluginKey,
      reviewedFingerprint: 'sha256-shown',
      decision: 'approve'
    })
  })

  it.each([
    ['catalog commit', { marketplaceCommit: 'e'.repeat(40) }],
    ['release commit', { resolvedCommit: 'e'.repeat(40) }],
    ['content hash', { contentHash: 'f'.repeat(64) }],
    ['execution profile', { manifest: codePreview.manifest }]
  ])('refuses a one-click install when the preview differs by %s', async (_field, change) => {
    const { hook, fetchPreview } = setup()
    fetchPreview.mockResolvedValue({
      ok: true,
      preview: { ...preview, ...change }
    })
    await act(async () => hook.current?.install(listing))
    expect(window.api.plugins.installMarketplacePlugin).not.toHaveBeenCalled()
    expect(hook.current?.phaseOf(listing.pluginKey)).toEqual({
      kind: 'error',
      message: 'The catalog changed since this page opened. Refresh it, then try again.'
    })
  })

  it('names a download that differs from the catalog and installs nothing', async () => {
    const { hook, onInstalled } = setup()
    vi.mocked(window.api.plugins.installMarketplacePlugin).mockResolvedValue({
      ok: false,
      error: 'plugin bytes do not match the catalog release'
    })
    await act(async () => hook.current?.install(listing))
    expect(hook.current?.phaseOf(listing.pluginKey)).toEqual({
      kind: 'error',
      message: 'The download didn’t match what the catalog published, so nothing was installed.'
    })
    expect(onInstalled).not.toHaveBeenCalled()
  })
})
