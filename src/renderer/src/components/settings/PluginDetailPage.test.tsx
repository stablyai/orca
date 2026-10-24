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
  it.each(['app-theme', 'icon-theme', 'terminal-theme'] as const)(
    'reserves its Use now line for an installed %s before registrations arrive',
    async (type) => {
      const entry: PluginListEntry = {
        ...pluginListEntryFromInstalled({ ...installed, execution: 'data' }),
        types: [type]
      }
      const container = await render(entry, () => Promise.resolve({ ok: true, preview }))
      expect(container.querySelector('.min-h-7')).not.toBeNull()
    }
  )

  it.each(['data', 'trusted-worker'] as const)(
    'keeps theme actions prominent for an installed %s plugin',
    async (execution) => {
      const entry: PluginListEntry = {
        ...pluginListEntryFromInstalled({ ...installed, execution }),
        types: ['app-theme']
      }
      const container = await render(entry, () => Promise.resolve({ ok: true, preview }))
      expect(container.querySelector('.min-h-7')).not.toBeNull()
    }
  )

  it('names what a catalog plugin adds from its manifest', async () => {
    const container = await render(pluginListEntryFromListing(listing), () =>
      Promise.resolve({ ok: true, preview })
    )
    expect(container.textContent).toContain('Minimal Icons')
    expect(container.textContent).toContain('File icon theme')
    // Why from the release: install refuses bytes whose profile differs from it.
    expect(container.textContent).toContain('Can’t reach anything outside its own files')
  })

  it('installs a content-only plugin in one click from its page', async () => {
    const container = await render(pluginListEntryFromListing(listing), () =>
      Promise.resolve({ ok: true, preview })
    )
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Install'
    )
    await act(async () => button?.click())
    expect(install.install).toHaveBeenCalledWith(listing, { preview })
  })

  it('never claims no access when the plugin could not be read, and retries', async () => {
    const fetchPreview = vi
      .fn<(target: PluginMarketplaceHostListing) => Promise<PluginPagePreview>>()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, preview })
    // Why no release: an older catalog vouches for no profile, so only the files can say.
    const container = await render(
      pluginListEntryFromListing({ ...listing, release: undefined }),
      fetchPreview
    )
    expect(container.textContent).toContain('Couldn’t read what it can access')
    expect(container.textContent).not.toContain('outside its own files')
    const installButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Install & enable')
    )
    expect(installButton?.disabled).toBe(true)

    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry'
    )
    await act(async () => retry?.click())
    expect(fetchPreview).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Can’t reach anything outside its own files')
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

  it('warns about the commands a panel plugin carries and discloses replaced shortcuts first', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
    const panelManifest = pluginManifestSchema.parse({
      ...manifest,
      contributes: {
        panels: [{ id: 'board', title: 'Board', entry: 'board.html' }],
        commands: [{ id: 'tasks', title: 'Open Tasks', action: 'sidebar.left.toggle' }],
        keybindings: [{ command: 'tasks', key: 'Mod+Alt+T' }]
      }
    })
    const panelListing: PluginMarketplaceHostListing = {
      ...listing,
      pluginKey: 'stablyai.board',
      release: { ...listing.release!, execution: 'sandboxed-ui', types: ['panel', 'instructions'] }
    }
    const container = await render(pluginListEntryFromListing(panelListing), () =>
      Promise.resolve({
        ok: true,
        preview: { ...preview, pluginKey: 'stablyai.board', manifest: panelManifest }
      })
    )
    expect(container.textContent).toContain(
      'Its commands and instructions can take actions when you or an agent use them.'
    )
    expect(container.textContent).not.toContain('These permissions limit what it can do')
    expect(container.textContent).not.toContain('outside its own files')
    expect(container.textContent).toMatch(/replaces your shortcut for/)
  })

  it('never arms Install & enable for a release other than the one the page shows', async () => {
    install.install.mockClear()
    const codeListing: PluginMarketplaceHostListing = {
      ...listing,
      pluginKey: 'stablyai.shortcuts',
      release: { ...listing.release!, execution: 'instructional', types: ['instructions'] }
    }
    const container = await render(pluginListEntryFromListing(codeListing), () =>
      Promise.resolve({
        ok: true,
        // Why a worker: the catalog moved on to a release that asks for more than the page shows.
        preview: {
          ...preview,
          pluginKey: 'stablyai.shortcuts',
          resolvedCommit: 'f'.repeat(40),
          manifest: { ...preview.manifest, main: 'dist/main.mjs' }
        }
      })
    )
    expect(container.textContent).toContain('Newer version available')
    const installButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Install & enable')
    )
    expect(installButton?.disabled).toBe(true)
    expect(install.install).not.toHaveBeenCalled()
  })

  const codeRelease = {
    ...listing,
    pluginKey: 'stablyai.shortcuts',
    release: {
      ...listing.release!,
      commit: 'd'.repeat(40),
      contentHash: 'e'.repeat(64),
      execution: 'instructional' as const,
      types: ['instructions' as const]
    }
  }
  const codeManifest = pluginManifestSchema.parse({
    ...manifest,
    contributes: { commands: [{ id: 'go', title: 'Go', action: 'sidebar.left.toggle' }] }
  })
  const codePreview = {
    ...preview,
    pluginKey: 'stablyai.shortcuts',
    resolvedCommit: 'd'.repeat(40),
    contentHash: 'e'.repeat(64),
    manifest: codeManifest
  }
  const installButton = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Install & enable')
    )

  it('puts the one decision beside the name and keeps the consent free of buttons', async () => {
    const container = await render(pluginListEntryFromListing(codeRelease), () =>
      Promise.resolve({ ok: true, preview: codePreview })
    )
    const consent = container.querySelector('[data-plugin-consent]')
    expect(consent?.querySelectorAll('button')).toHaveLength(0)
    const decisions = Array.from(container.querySelectorAll('button')).filter((button) =>
      button.textContent?.includes('Install & enable')
    )
    expect(decisions).toHaveLength(1)
    // Why before the consent: the button sits top-right in the header, the consent under it.
    expect(
      decisions[0]!.compareDocumentPosition(consent!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('arms Install & enable only for the exact release it shows', async () => {
    const container = await render(pluginListEntryFromListing(codeRelease), () =>
      Promise.resolve({ ok: true, preview: codePreview })
    )
    expect(installButton(container)?.disabled).toBe(false)
    expect(container.textContent).not.toContain('Newer version available')
  })

  it.each([
    ['catalog commit', { marketplaceCommit: 'f'.repeat(40) }],
    ['release commit', { resolvedCommit: 'f'.repeat(40) }],
    ['content hash', { contentHash: 'f'.repeat(64) }],
    ['execution profile', { manifest: { ...codeManifest, main: 'dist/main.mjs' } }]
  ])('disarms when the preview differs by %s', async (_field, change) => {
    const container = await render(pluginListEntryFromListing(codeRelease), () =>
      Promise.resolve({ ok: true, preview: { ...codePreview, ...change } })
    )
    expect(container.textContent).toContain('Newer version available')
    expect(installButton(container)?.disabled).toBe(true)
  })

  it('gives no access verdict while the plugin is still being read', async () => {
    const summarized = {
      ...codeRelease,
      release: { ...codeRelease.release, capabilities: [] }
    }
    let resolvePreview: (result: PluginPagePreview) => void = () => {}
    const container = await render(
      pluginListEntryFromListing(summarized),
      () => new Promise((resolve) => (resolvePreview = resolve))
    )
    expect(container.textContent).toContain('Reading what it can access…')
    expect(container.textContent).not.toContain('It asks for no other access.')
    await act(async () => resolvePreview({ ok: true, preview: codePreview }))
    expect(container.textContent).toContain('It asks for no other access.')
  })

  it('disarms while a catalog refresh is in flight', async () => {
    const container = await render(
      pluginListEntryFromListing(codeRelease),
      () => Promise.resolve({ ok: true, preview: codePreview }),
      { refreshing: true }
    )
    expect(installButton(container)?.disabled).toBe(true)
  })

  it('trusts the full preview over a capped catalog summary', async () => {
    const capped = Array.from({ length: 64 }, (_, index) => ({
      kind: 'panels' as const,
      name: `Panel ${index}`
    }))
    const panelListing = {
      ...codeRelease,
      release: { ...codeRelease.release, execution: 'sandboxed-ui' as const, contributes: capped }
    }
    const panelManifest = pluginManifestSchema.parse({
      ...manifest,
      contributes: {
        panels: [{ id: 'p', title: 'P', entry: 'p.html' }],
        commands: [{ id: 'go', title: 'Go', action: 'sidebar.left.toggle' }]
      }
    })
    // Why both: before the preview the capped summary is unknown, after it the manifest decides.
    let resolvePreview: (result: PluginPagePreview) => void = () => {}
    const container = await render(
      pluginListEntryFromListing(panelListing),
      () => new Promise((resolve) => (resolvePreview = resolve))
    )
    expect(container.textContent).toContain(
      'Its commands and instructions can take actions when you or an agent use them.'
    )
    await act(async () =>
      resolvePreview({ ok: true, preview: { ...codePreview, manifest: panelManifest } })
    )
    expect(container.textContent).toContain(
      'Its commands and instructions can take actions when you or an agent use them.'
    )
    expect(container.textContent).not.toContain('These permissions limit what it can do')
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
