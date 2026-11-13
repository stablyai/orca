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
} from '@/store/plugins/installation/plugin-install-trust-request'
import type { PluginInstallTrustPrompt } from '../presentation/plugin-install-trust'
import { usePluginInstallAction } from './use-plugin-install-action'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn() } }))
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
  vi.mocked(toast.warning).mockClear()
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
  it('leaves an install link’s replacement from a moved repository off and unapproved', async () => {
    const codeListing = {
      ...listing,
      release: { ...listing.release!, execution: 'declarative' as const }
    }
    const movedCode = { ...codePreview, repositoryMoved: true as const }
    for (const [target, moved, approve] of [
      [listing, { ...preview, repositoryMoved: true as const }, undefined],
      [codeListing, movedCode, { preview: movedCode }]
    ] as const) {
      const { hook, fetchPreview, onInstalled } = setup(() => true)
      fetchPreview.mockResolvedValue({ ok: true, preview: moved })
      vi.mocked(window.api.plugins.installMarketplacePlugin).mockResolvedValue(installResult(false))
      await act(async () => hook.current?.install(target, approve))
      expect(window.api.plugins.installMarketplacePlugin).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ enableIfData: true })
      )
      expect(window.api.plugins.consent).not.toHaveBeenCalled()
      expect(applyPluginThemesNow).not.toHaveBeenCalled()
      expect(hook.current?.phaseOf(listing.pluginKey)).toBeNull()
      expect(onInstalled).toHaveBeenCalledWith(listing.pluginKey)
      expect(toast.warning).toHaveBeenLastCalledWith(
        'Dusk 1.0.0 comes from a different repository',
        expect.objectContaining({ description: 'It stays off until you review it.' })
      )
      expect(toast.success).not.toHaveBeenCalled()
    }
  })
})
