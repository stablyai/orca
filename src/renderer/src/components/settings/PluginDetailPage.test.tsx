// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginHostListEntry,
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing
} from '../../../../preload/api-types'
import { usePluginSyntaxFailureStore } from '@/store/plugin-syntax-failures'
import { usePluginSyntaxStore } from '@/store/plugin-syntax-packs'
import { usePluginThemeStore } from '@/store/plugin-themes'
import { pluginManifestSchema } from '../../../../shared/plugins/plugin-manifest'
import {
  pluginListEntryFromInstalled,
  pluginListEntryFromListing,
  type PluginListEntry
} from '../plugin-catalog/plugin-list-entries'
import { PluginDetailPage } from './PluginDetailPage'
import type { PluginPagePreview } from './use-plugin-catalog'

vi.mock('../ui/tooltip', () => ({
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
    iconThemes: [{ id: 'minimal', label: 'Minimal Icons', path: 'icons/theme.json' }]
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

const installed: PluginHostListEntry = {
  pluginKey: 'stablyai.gleam',
  consentFingerprint: 'sha256-gleam',
  name: 'Gleam',
  version: '1.0.0',
  publisher: 'stablyai',
  status: 'idle',
  needsReconsent: false,
  isDev: false,
  official: false,
  bundled: false,
  capabilities: [],
  panels: [],
  commands: [],
  hasWorker: false,
  execution: 'data',
  restarts: 0,
  source: { kind: 'local-path', reference: '/tmp/gleam', resolvedCommit: null, contentHash: 'h' }
}

let root: Root | null = null

async function render(
  entry: PluginListEntry,
  fetchPreview: (target: PluginMarketplaceHostListing) => Promise<PluginPagePreview>
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
        onInstall={vi.fn()}
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
  it('names what a catalog plugin adds from its manifest', async () => {
    const container = await render(pluginListEntryFromListing(listing), () =>
      Promise.resolve({ ok: true, preview })
    )
    expect(container.textContent).toContain('Minimal Icons')
    expect(container.textContent).toContain('File icon theme')
    expect(container.textContent).toContain('Nothing outside its own files')
  })

  it('never claims no access when the plugin could not be read, and retries', async () => {
    const fetchPreview = vi
      .fn<(target: PluginMarketplaceHostListing) => Promise<PluginPagePreview>>()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, preview })
    const container = await render(pluginListEntryFromListing(listing), fetchPreview)
    expect(container.textContent).toContain('Couldn’t read what it can access')
    expect(container.textContent).not.toContain('Nothing outside its own files')

    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry'
    )
    await act(async () => retry?.click())
    expect(fetchPreview).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Nothing outside its own files')
  })

  it('names an installed plugin’s syntax and says when its grammar failed', async () => {
    usePluginSyntaxStore.setState({
      loaded: true,
      entries: [
        {
          id: 'plugin:stablyai.gleam/gleam',
          pluginKey: 'stablyai.gleam',
          label: 'Gleam',
          extensions: ['.gleam'],
          filenames: [],
          revision: '1'
        }
      ]
    })
    usePluginSyntaxFailureStore.setState({
      failures: { 'plugin:stablyai.gleam/gleam@1': 'crashed' }
    })
    const container = await render(pluginListEntryFromInstalled(installed), vi.fn())
    expect(container.textContent).toContain('Gleam')
    expect(container.textContent).toContain('Highlighting stopped: this grammar failed.')
  })

  it('never calls a commands plugin content only, before or after its manifest is read', async () => {
    const commandsListing: PluginMarketplaceHostListing = {
      ...listing,
      pluginKey: 'stablyai.shortcuts',
      release: { ...listing.release!, execution: 'instructional', types: ['instructions'] }
    }
    let resolvePreview: (result: PluginPagePreview) => void = () => {}
    const container = await render(
      pluginListEntryFromListing(commandsListing),
      () => new Promise((resolve) => (resolvePreview = resolve))
    )
    expect(container.textContent).not.toContain('Content only')
    // Why no capabilities: the old page read "no worker" as "no code that runs".
    await act(async () =>
      resolvePreview({
        ok: true,
        preview: {
          ...preview,
          pluginKey: 'stablyai.shortcuts',
          manifest: { ...preview.manifest, capabilities: [] }
        }
      })
    )
    expect(container.textContent).not.toContain('Content only')
    expect(container.textContent).toContain(
      'Its commands and instructions can take actions when you or an agent use them.'
    )
  })

  it('warns that an installed worker plugin has full access even without capabilities', async () => {
    const container = await render(
      pluginListEntryFromInstalled({ ...installed, hasWorker: true, execution: 'trusted-worker' }),
      vi.fn()
    )
    expect(container.textContent).not.toContain('sandbox')
    expect(container.textContent).toContain(
      'Its worker runs as a normal process with full access to your files, network, and other processes.'
    )
  })

  it('names what a plugin under review adds from its installed manifest', async () => {
    vi.mocked(window.api.plugins.getInstalledManifest).mockResolvedValue(preview.manifest)
    const container = await render(
      pluginListEntryFromInstalled({
        ...installed,
        pluginKey: 'stablyai.icons',
        status: 'pending'
      }),
      vi.fn()
    )
    expect(window.api.plugins.getInstalledManifest).toHaveBeenCalledWith({
      pluginKey: 'stablyai.icons'
    })
    expect(container.textContent).toContain('Minimal Icons')
    expect(container.textContent).toContain('File icon theme')
  })
})
