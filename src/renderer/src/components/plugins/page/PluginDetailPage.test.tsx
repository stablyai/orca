// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing
} from '../../../../../preload/api-types'
import { usePluginSyntaxFailureStore } from '@/store/plugin-syntax-failures'
import { usePluginSyntaxStore } from '@/store/plugin-syntax-packs'
import { usePluginThemeStore } from '@/store/plugin-themes'
import { pluginManifestSchema } from '../../../../../shared/plugins/manifest/plugin-manifest'
import { pluginListEntryFromListing, type PluginListEntry } from '../list/plugin-list-entries'
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
  { refreshing = false }: { refreshing?: boolean } = {}
): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
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
  it('shows author links and hotlinked images as nothing, and links only the install source', async () => {
    const container = await render(
      pluginListEntryFromListing({
        ...listing,
        source: { kind: 'git', url: 'https://github.com/Acme/icons.git', ref: 'main' },
        description: 'Docs at https://evil.example and [click](javascript:alert(1))',
        homepage: 'https://evil.example/home',
        repository: 'https://evil.example/repo',
        changelog: 'See <a href="https://evil.example">notes</a>',
        images: { cover: { url: 'https://tracker.example/pixel.png', alt: 'Cover' } }
      }),
      () => Promise.resolve({ ok: true, preview })
    )
    expect(container.querySelectorAll('a, img')).toHaveLength(0)
    expect(container.textContent).toContain('See <a href="https://evil.example">notes</a>')
    expect(container.textContent).not.toContain('Homepage')
    const repository = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Repository'
    )
    await act(async () => repository?.click())
    expect(window.api.shell.openUrl).toHaveBeenCalledWith('https://github.com/acme/icons')
    const readme = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Read the README on GitHub'
    )
    await act(async () => readme?.click())
    expect(window.api.shell.openUrl).toHaveBeenCalledWith(
      `https://github.com/acme/icons/tree/${'d'.repeat(40)}#readme`
    )
  })
})
