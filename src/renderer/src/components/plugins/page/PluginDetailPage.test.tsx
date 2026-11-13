// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing
} from '../../../../../preload/api/plugin-host-api'
import { usePluginSyntaxFailureStore } from '@/store/plugins/syntax/plugin-syntax-failures'
import { usePluginSyntaxStore } from '@/store/plugins/syntax/plugin-syntax-packs'
import { usePluginThemeStore } from '@/store/plugins/appearance/plugin-themes'
import { pluginManifestSchema } from '../../../../../shared/plugins/manifest/plugin-manifest'
import {
  pluginListEntryFromInstalled,
  pluginListEntryFromListing,
  type PluginListEntry
} from '../list/plugin-list-entries'
import { PluginDetailPage } from './PluginDetailPage'
import type { PluginPagePreview } from '../state/use-plugin-catalog'

vi.mock('../../ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))

const listing: PluginMarketplaceHostListing = {
  marketplaceSourceId: 'official',
  marketplaceName: 'Orca Official Plugins',
  marketplaceOwner: 'stablyai',
  marketplaceCommit: 'c',
  pluginKey: 'stablyai.orca-minimal-icons',
  source: { kind: 'git', url: 'https://example.invalid/icons.git', ref: 'main' },
  description: 'Monochrome icons.',
  categories: ['icons'],
  official: true,
  bundled: false,
  release: {
    version: '1.0.0',
    commit: 'd'.repeat(40),
    contentHash: 'e'.repeat(64),
    execution: 'data',
    minimumOrca: '1.0.0',
    types: ['icon-theme']
  }
}

const manifest = pluginManifestSchema.parse({
  manifestVersion: 1,
  id: 'orca-minimal-icons',
  publisher: 'stablyai',
  name: 'Orca Minimal Icons',
  version: '1.0.0',
  engines: { orca: '>=1.0.0' },
  pluginApi: 1,
  contributes: {
    iconThemes: [{ id: 'minimal', title: 'Minimal Icons', path: 'icons/theme.json' }]
  }
})

const preview: PluginMarketplaceHostInstallPreview = {
  marketplaceSourceId: 'official',
  marketplaceName: 'Orca Official Plugins',
  marketplaceOwner: 'stablyai',
  marketplaceCommit: 'c',
  pluginKey: listing.pluginKey,
  source: listing.source,
  resolvedCommit: 'd'.repeat(40),
  contentHash: 'e'.repeat(64),
  consentFingerprint: 'f',
  manifest,
  official: true,
  bundled: false
}

let root: Root | null = null
const install = {
  phaseOf: () => null,
  install: vi.fn().mockResolvedValue(undefined),
  dismiss: vi.fn()
}

async function render(
  entry: PluginListEntry,
  fetchPreview: (target: PluginMarketplaceHostListing) => Promise<PluginPagePreview>,
  {
    refreshing = false,
    container = document.createElement('div')
  }: {
    refreshing?: boolean
    container?: HTMLDivElement
  } = {}
): Promise<HTMLDivElement> {
  if (!root) {
    document.body.appendChild(container)
    root = createRoot(container)
  }
  await act(async () => {
    root?.render(
      <PluginDetailPage
        entry={entry}
        busy={false}
        orcaVersion="1.4.214"
        logsState={undefined}
        handlers={{
          onOpen: vi.fn(),
          onReview: vi.fn(),
          onToggleEnabled: vi.fn(),
          onRestart: vi.fn(),
          onViewLogs: vi.fn(),
          onCheckUpdate: vi.fn(),
          onRollbackRequest: vi.fn(),
          onRemoveRequest: vi.fn()
        }}
        fetchPreview={fetchPreview}
        install={install}
        refreshing={refreshing}
        onConsent={vi.fn().mockResolvedValue(undefined)}
        onBack={vi.fn()}
        onOpenShortcuts={vi.fn()}
        entries={{ installed: [], available: [] }}
        onOpenPlugin={vi.fn()}
      />
    )
  })
  return container
}

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plugins: {
        getRollbackVersion: vi.fn().mockResolvedValue(null),
        getInstalledManifest: vi.fn().mockResolvedValue(null)
      },
      shell: { openUrl: vi.fn() }
    }
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  usePluginSyntaxStore.setState({ entries: [], loaded: false })
  usePluginThemeStore.setState({ entries: [], loaded: false })
  usePluginSyntaxFailureStore.setState({ failures: {} })
})

describe('PluginDetailPage', () => {
  it('keeps the README reachable after installation at the installed source commit', async () => {
    const entry = pluginListEntryFromListing({
      ...listing,
      source: {
        kind: 'git',
        url: 'https://github.com/acme/plugins',
        ref: 'main',
        path: 'plugins/icons'
      }
    })
    const fetchPreview = () => new Promise<PluginPagePreview>(() => undefined)
    const container = await render(entry, fetchPreview)
    await render(
      pluginListEntryFromInstalled(
        {
          pluginKey: entry.pluginKey,
          name: 'Icons',
          publisher: 'stablyai',
          version: '1.0.0',
          status: 'disabled',
          execution: 'data',
          consentFingerprint: null,
          needsReconsent: false,
          isDev: false,
          official: false,
          bundled: false,
          capabilities: [],
          panels: [],
          commands: [],
          hasWorker: false,
          restarts: 0,
          source: {
            kind: 'marketplace',
            reference: 'https://github.com/acme/plugins (plugins/icons)',
            url: 'https://github.com/acme/plugins',
            path: 'plugins/icons',
            resolvedCommit: 'a'.repeat(40),
            contentHash: 'e'.repeat(64)
          }
        },
        entry.listing
      ),
      fetchPreview,
      { container }
    )
    const readme = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Read the README on GitHub'
    )
    await act(async () => readme?.click())
    expect(window.api.shell.openUrl).toHaveBeenCalledWith(
      'https://github.com/acme/plugins/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plugins/icons#readme'
    )
  })

  it('does not turn a catalog repository claim into an account identity or load hotlinked images', async () => {
    const container = await render(
      pluginListEntryFromListing({
        ...listing,
        pluginKey: 'victim.icons',
        source: { kind: 'git', url: 'https://github.com/mirror/icons.git', ref: 'main' },
        release: { ...listing.release!, repository: 'https://github.com/victim/icons' },
        description: 'Docs at https://evil.example and [click](javascript:alert(1))',
        homepage: 'https://evil.example/home',
        repository: 'https://evil.example/repo',
        changelog: 'See <a href="https://evil.example">notes</a>',
        images: { cover: { url: 'https://tracker.example/pixel.png', alt: 'Cover' } }
      }),
      () => Promise.resolve({ ok: true, preview })
    )
    expect(container.querySelectorAll('a, img')).toHaveLength(0)
    const repository = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Repository'
    )
    await act(async () => repository?.click())
    expect(window.api.shell.openUrl).toHaveBeenCalledWith('https://github.com/victim/icons')
    const readme = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Read the README on GitHub'
    )
    await act(async () => readme?.click())
    expect(window.api.shell.openUrl).toHaveBeenCalledWith(
      'https://github.com/mirror/icons/tree/dddddddddddddddddddddddddddddddddddddddd#readme'
    )
  })

  it('keeps source links on the displayed release during a catalog refresh', async () => {
    const original = pluginListEntryFromListing({
      ...listing,
      pluginKey: 'acme.icons',
      source: { kind: 'git', url: 'https://github.com/acme/icons', ref: 'main' }
    })
    const fetchPreview = vi.fn(() => new Promise<PluginPagePreview>(() => undefined))
    const container = await render(original, fetchPreview)
    await render(
      pluginListEntryFromListing({
        ...original.listing!,
        marketplaceCommit: 'new-commit',
        source: { kind: 'git', url: 'https://gitlab.com/acme/icons', ref: 'main' }
      }),
      fetchPreview,
      { container }
    )
    for (const button of container.querySelectorAll('button')) {
      if (button.textContent === 'Repository') {
        await act(async () => button.click())
      }
    }
    const urls = vi.mocked(window.api.shell.openUrl).mock.calls.map(([url]) => url)
    expect(urls).toContain('https://github.com/acme/icons')
    expect(urls.some((url) => url.includes('gitlab.com'))).toBe(false)
  })
})
