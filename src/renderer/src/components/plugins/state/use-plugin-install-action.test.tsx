// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing
} from '../../../../../preload/api-types'
import { pluginManifestSchema } from '../../../../../shared/plugins/manifest/plugin-manifest'
import {
  settlePluginInstallTrust,
  usePluginInstallTrustStore
} from '@/store/plugin-install-trust-request'
import type { PluginInstallTrustPrompt } from '../presentation/plugin-install-trust'
import { usePluginInstallAction } from './use-plugin-install-action'

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('./plugin-theme-apply', () => ({ applyPluginThemesNow: vi.fn() }))
import { toast } from 'sonner'
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
    contributes: { themes: [{ id: 'dusk', title: 'Dusk', path: 'themes/dusk.json' }] }
  })
}

const codePreview: PluginMarketplaceHostInstallPreview = {
  ...preview,
  manifest: pluginManifestSchema.parse({
    ...preview.manifest,
    contributes: { commands: [{ id: 'go', title: 'Go', action: 'sidebar.left.toggle' }] }
  })
}

function setup(isFromInstallLink?: (pluginKey: string) => boolean) {
  const onInstalled = vi.fn().mockResolvedValue(undefined)
  const fetchPreview = vi.fn().mockResolvedValue({ ok: true, preview })
  const hook: { current: ReturnType<typeof usePluginInstallAction> | null } = { current: null }
  function Probe(): null {
    hook.current = usePluginInstallAction({ fetchPreview, onInstalled, isFromInstallLink })
    return null
  }
  act(() => createRoot(document.createElement('div')).render(<Probe />))
  return { hook, onInstalled, fetchPreview }
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

// Answers every trust ask the way the current test chose, recording what was shown.
const asked: PluginInstallTrustPrompt[] = []
let answer = true
usePluginInstallTrustStore.subscribe(({ pending }) => {
  if (pending) {
    asked.push(pending.prompt)
    queueMicrotask(() => settlePluginInstallTrust(answer))
  }
})

beforeEach(() => {
  asked.length = 0
  answer = true
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

describe('usePluginInstallAction', () => {
  it('labels an install from a page an install link opened, and only that one', async () => {
    const { hook } = setup((pluginKey) => pluginKey === listing.pluginKey)
    await act(async () => hook.current?.install(listing))
    expect(window.api.plugins.installMarketplacePlugin).toHaveBeenCalledWith(
      expect.objectContaining({ fromInstallLink: true })
    )
    const plain = setup()
    await act(async () => plain.hook.current?.install(listing))
    expect(window.api.plugins.installMarketplacePlugin).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ fromInstallLink: true })
    )
  })

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

  it('keeps the Try it toast up long enough to click', async () => {
    const { hook, fetchPreview } = setup()
    const manifest = pluginManifestSchema.parse({
      ...preview.manifest,
      contributes: {
        syntaxes: [
          {
            id: 'gleam',
            title: 'Gleam',
            scopeName: 'source.gleam',
            path: 'g.json',
            extensions: ['.gleam']
          }
        ]
      }
    })
    fetchPreview.mockResolvedValue({ ok: true, preview: { ...preview, manifest } })
    await act(async () => hook.current?.install(listing))
    expect(toast.success).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        duration: 10_000,
        action: expect.objectContaining({ label: 'Try it' })
      })
    )
  })

  it('offers no Try it when nothing shows the plugin off directly', async () => {
    const { hook } = setup()
    await act(async () => hook.current?.install(listing))
    expect(toast.success).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: undefined })
    )
  })

  it('approves exactly the fingerprint the page showed for a plugin that runs code', async () => {
    const { hook } = setup()
    const codeListing = {
      ...listing,
      release: { ...listing.release!, execution: 'declarative' as const }
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
      message: 'The catalog changed. Refresh and try again.'
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
      message: 'Download didn’t match the catalog. Nothing installed.'
    })
    expect(onInstalled).not.toHaveBeenCalled()
  })

  it('asks to trust the publisher of a community theme with the softer copy, then installs', async () => {
    const { hook } = setup()
    await act(async () => hook.current?.install(listing))
    expect(asked).toEqual([
      {
        kind: 'theme',
        trustee: 'acme',
        publisher: 'acme',
        repository: 'https://example.invalid/dusk.git',
        location: 'Catalog',
        access: []
      }
    ])
    expect(window.api.plugins.installMarketplacePlugin).toHaveBeenCalledOnce()
  })

  it('names the repository owner Orca parsed, not the publisher the manifest claims', async () => {
    const { hook, fetchPreview } = setup()
    const source = { kind: 'git' as const, url: 'https://github.com/Mallory/dusk.git', ref: 'main' }
    fetchPreview.mockResolvedValue({ ok: true, preview: { ...preview, source } })
    await act(async () => hook.current?.install({ ...listing, source }))
    expect(asked[0]).toMatchObject({
      trustee: 'Mallory',
      publisher: 'acme',
      repository: 'github.com/mallory/dusk'
    })
  })

  it('warns that a community code plugin runs its code, with what it may do', async () => {
    const { hook } = setup()
    const codeListing = {
      ...listing,
      release: { ...listing.release!, execution: 'declarative' as const }
    }
    vi.mocked(window.api.plugins.installMarketplacePlugin).mockResolvedValue(installResult(false))
    await act(async () => hook.current?.install(codeListing, { preview: codePreview }))
    expect(asked).toHaveLength(1)
    expect(asked[0]!.kind).toBe('code')
    expect(asked[0]!.access).toEqual(['Its commands can act for you or your agents'])
  })

  it('installs nothing when the user cancels, and leaves no error behind', async () => {
    answer = false
    const { hook, onInstalled } = setup()
    await act(async () => hook.current?.install(listing))
    expect(asked).toHaveLength(1)
    expect(window.api.plugins.installMarketplacePlugin).not.toHaveBeenCalled()
    expect(onInstalled).not.toHaveBeenCalled()
    expect(hook.current?.phaseOf(listing.pluginKey)).toBeNull()
  })

  it('never asks for an official plugin', async () => {
    const { hook, fetchPreview } = setup()
    fetchPreview.mockResolvedValue({ ok: true, preview: { ...preview, official: true } })
    await act(async () => hook.current?.install({ ...listing, official: true }))
    expect(asked).toEqual([])
    expect(window.api.plugins.installMarketplacePlugin).toHaveBeenCalledOnce()
  })

  it('asks when only one of listing and preview says official', async () => {
    const { hook } = setup()
    await act(async () => hook.current?.install({ ...listing, official: true }))
    expect(asked).toHaveLength(1)
  })
})
