// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginHostListEntry,
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing,
  PluginMarketplaceHostSourceState
} from '../../../../../preload/api-types'
import { requestPluginPreview } from '@/store/plugin-preview-request'
import { PluginManager } from './PluginManager'
import { usePluginPageNavigation } from '../state/use-plugin-page-navigation'

vi.mock('../../ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))
vi.mock('../../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled
  }: {
    children: React.ReactNode
    onSelect?: () => void
    disabled?: boolean
  }) => (
    <button disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  DropdownMenuSeparator: () => null,
  DropdownMenuShortcut: () => null
}))
vi.mock('../dialogs/PluginMarketplaceSourceDialog', () => ({
  PluginMarketplaceSourceDialog: () => null
}))

const SOURCE_ID = 'a'.repeat(32)
const MARKETPLACE_COMMIT = 'b'.repeat(40)
const PLUGIN_COMMIT = 'c'.repeat(40)

const source: PluginMarketplaceHostSourceState = {
  id: SOURCE_ID,
  source: { kind: 'git', url: 'https://example.com/marketplace.git', ref: 'main' },
  addedAt: 1,
  marketplace: {
    name: 'Community',
    owner: 'example',
    resolvedCommit: MARKETPLACE_COMMIT,
    fetchedAt: 2
  },
  stale: false,
  official: false
}

const listing: PluginMarketplaceHostListing = {
  marketplaceSourceId: SOURCE_ID,
  marketplaceName: 'Community',
  marketplaceOwner: 'example',
  marketplaceCommit: MARKETPLACE_COMMIT,
  pluginKey: 'example.notes',
  source: { kind: 'git', url: 'https://example.com/notes.git', ref: 'v1' },
  description: 'Notes for active worktrees.',
  categories: ['productivity'],
  official: false,
  bundled: false
}

const preview: PluginMarketplaceHostInstallPreview = {
  ...listing,
  resolvedCommit: PLUGIN_COMMIT,
  contentHash: 'sha256-content',
  consentFingerprint: 'sha256-consent',
  manifest: {
    manifestVersion: 1,
    id: 'notes',
    publisher: 'example',
    name: 'Worktree Notes',
    version: '1.0.0',
    description: 'Notes for active worktrees.',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    main: 'dist/worker.js',
    contributes: {
      panels: [],
      commands: [],
      events: [],
      languagePacks: [],
      keybindings: [],
      vmRecipes: [],
      agents: [],
      themes: [],
      terminalThemes: [],
      iconThemes: [],
      syntaxes: []
    },
    capabilities: [{ kind: 'workspace:read' }]
  }
}

function installedPlugin(contentHash = 'different-content'): PluginHostListEntry {
  return {
    pluginKey: listing.pluginKey,
    consentFingerprint: 'sha256-consent',
    name: 'Worktree Notes',
    version: '1.0.0',
    publisher: 'example',
    status: 'idle',
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
      reference: listing.source.url,
      resolvedCommit: PLUGIN_COMMIT,
      contentHash,
      marketplace: { reference: source.source.url, resolvedCommit: MARKETPLACE_COMMIT }
    }
  }
}

function installApi(overrides: Record<string, unknown> = {}): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plugins: {
        listMarketplaces: vi.fn().mockResolvedValue([source]),
        listMarketplacePlugins: vi.fn().mockResolvedValue([listing]),
        refreshMarketplaces: vi.fn().mockResolvedValue([source]),
        previewMarketplacePlugin: vi.fn().mockResolvedValue(preview),
        previewMarketplaceUpdate: vi.fn().mockResolvedValue(preview),
        getRollbackVersion: vi.fn().mockResolvedValue(null),
        getInstalledManifest: vi.fn().mockResolvedValue(null),
        consent: vi.fn().mockResolvedValue([]),
        installMarketplacePlugin: vi.fn().mockResolvedValue({
          ok: true,
          pluginKey: listing.pluginKey,
          version: preview.manifest.version,
          contentHash: preview.contentHash,
          consentFingerprint: preview.consentFingerprint,
          resolvedCommit: preview.resolvedCommit
        }),
        ...overrides
      },
      updater: { getVersion: vi.fn().mockResolvedValue('1.4.214') },
      ui: { writeClipboardText: vi.fn() }
    }
  })
}

let root: Root | null = null

function Harness({
  plugins,
  onInstalled,
  onRemoveRequest,
  onToggleEnabled
}: {
  plugins: PluginHostListEntry[]
  onInstalled: (keys: string | readonly string[]) => Promise<void>
  onRemoveRequest: (pluginKey: string) => void
  onToggleEnabled: (pluginKey: string) => void
}): React.JSX.Element {
  const page = usePluginPageNavigation()
  return (
    <PluginManager
      plugins={plugins}
      pluginsLoading={false}
      pluginsError={null}
      busyPluginKeys={new Set()}
      handlers={{
        onOpen: vi.fn(),
        onReview: vi.fn(),
        onToggleEnabled,
        onRestart: vi.fn(),
        onViewLogs: vi.fn(),
        onRollbackRequest: vi.fn(),
        onRemoveRequest
      }}
      onRefreshInstalled={vi.fn().mockResolvedValue(undefined)}
      onInstalled={onInstalled}
      logsByPlugin={{}}
      onShowLogs={vi.fn()}
      onOpenShortcuts={vi.fn()}
      page={page}
      sourcesOpen={false}
      setSourcesOpen={vi.fn()}
      onConsent={vi.fn().mockResolvedValue(undefined)}
    />
  )
}

async function render(
  plugins: PluginHostListEntry[] = [],
  onInstalled = vi.fn().mockResolvedValue(undefined),
  onRemoveRequest: (pluginKey: string) => void = vi.fn().mockResolvedValue(undefined),
  onToggleEnabled: (pluginKey: string) => void = vi.fn()
): Promise<{ container: HTMLDivElement; onInstalled: typeof onInstalled }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <Harness
        plugins={plugins}
        onInstalled={onInstalled}
        onRemoveRequest={onRemoveRequest}
        onToggleEnabled={onToggleEnabled}
      />
    )
  })
  return { container, onInstalled }
}

function buttons(label: string): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('button')).filter(
    (candidate) => candidate.textContent?.trim() === label
  )
}

function button(label: string): HTMLButtonElement {
  const match = buttons(label)[0]
  if (!match) {
    throw new Error(`missing ${label} button`)
  }
  return match
}

beforeEach(() => installApi())

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('PluginManager catalog', () => {
  it('installs a content-only plugin in one click and lets main decide it turns on', async () => {
    const themeListing: PluginMarketplaceHostListing = {
      ...listing,
      release: {
        version: '1.0.0',
        commit: PLUGIN_COMMIT,
        contentHash: 'd'.repeat(64),
        execution: 'data',
        minimumOrca: '1.0.0',
        types: ['app-theme']
      }
    }
    installApi({
      listMarketplacePlugins: vi.fn().mockResolvedValue([themeListing]),
      previewMarketplacePlugin: vi.fn().mockResolvedValue({
        ...preview,
        contentHash: 'd'.repeat(64),
        manifest: {
          ...preview.manifest,
          main: undefined,
          capabilities: [],
          contributes: {
            ...preview.manifest.contributes,
            themes: [{ id: 'dusk', label: 'Dusk', path: 'themes/dusk.json' }]
          }
        }
      })
    })
    const { onInstalled } = await render()
    await act(async () => button('Install').click())

    expect(window.api.plugins.installMarketplacePlugin).toHaveBeenCalledWith({
      marketplaceSourceId: SOURCE_ID,
      marketplaceCommit: MARKETPLACE_COMMIT,
      pluginKey: listing.pluginKey,
      resolvedCommit: PLUGIN_COMMIT,
      enableIfData: true,
      expectedFingerprint: preview.consentFingerprint
    })
    expect(window.api.plugins.consent).not.toHaveBeenCalled()
    expect(buttons('Install plugin')).toHaveLength(0)
    expect(onInstalled).toHaveBeenCalledWith(listing.pluginKey)
  })

  it('reviews a plugin that runs code on its page and approves exactly what it showed', async () => {
    const { onInstalled } = await render()
    await act(async () => button('Review & install').click())
    expect(document.body.textContent).toContain('If you install Worktree Notes, it can:')
    expect(document.body.textContent).toContain(
      'Its worker runs as a normal process with full access to your files, network, and other processes.'
    )

    await act(async () => button('Install & enable').click())
    expect(window.api.plugins.installMarketplacePlugin).toHaveBeenCalledWith({
      marketplaceSourceId: SOURCE_ID,
      marketplaceCommit: MARKETPLACE_COMMIT,
      pluginKey: listing.pluginKey,
      resolvedCommit: PLUGIN_COMMIT
    })
    expect(window.api.plugins.consent).toHaveBeenCalledWith({
      pluginKey: listing.pluginKey,
      reviewedFingerprint: preview.consentFingerprint,
      decision: 'approve'
    })
    expect(onInstalled).toHaveBeenCalledWith(listing.pluginKey)
  })

  it('never offers Install for a listing the safety list revoked', async () => {
    installApi({
      listMarketplacePlugins: vi
        .fn()
        .mockResolvedValue([
          { ...listing, blockedByKillList: { reason: 'Known credential theft' } }
        ])
    })
    const { container } = await render()
    expect(container.textContent).toContain('Known credential theft')
    expect(buttons('Install')).toHaveLength(0)
    expect(buttons('Review & install')).toHaveLength(0)
    expect(window.api.plugins.previewMarketplacePlugin).not.toHaveBeenCalled()
  })

  it('requests the shared removal confirmation from the card without deleting data', async () => {
    const onRemoveRequest = vi.fn()
    const { container } = await render(
      [installedPlugin(preview.contentHash)],
      undefined,
      onRemoveRequest
    )
    const more = container.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions for Worktree Notes"]'
    )
    expect(more).toBeTruthy()
    expect(more?.closest('[data-plugin-row-name]')).toBeNull()
    await act(async () => button('Remove').click())

    expect(onRemoveRequest).toHaveBeenCalledWith(listing.pluginKey)
  })

  it('offers Disable for one installed plugin, never the global Turn off wording', async () => {
    const onToggleEnabled = vi.fn()
    await render([installedPlugin(preview.contentHash)], undefined, undefined, onToggleEnabled)
    expect(buttons('Disable')).toHaveLength(1)
    expect(buttons('Turn off')).toHaveLength(0)
    expect(buttons('Turn on')).toHaveLength(0)
    await act(async () => button('Disable').click())

    expect(onToggleEnabled).toHaveBeenCalledWith(listing.pluginKey)
  })

  it('offers Enable for one disabled plugin', async () => {
    await render([{ ...installedPlugin(preview.contentHash), status: 'disabled' }])
    expect(buttons('Enable')).toHaveLength(1)
    expect(buttons('Disable')).toHaveLength(0)
  })

  it('says when an update preview matches the installed bytes', async () => {
    const { container } = await render([installedPlugin(preview.contentHash)])
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-plugin-row-name]')?.click()
    )
    await act(async () => button('Check for update').click())

    expect(window.api.plugins.previewMarketplaceUpdate).toHaveBeenCalledWith({
      pluginKey: listing.pluginKey
    })
    expect(document.body.textContent).toContain('This exact plugin content is already installed.')
    expect(buttons('Update 1 plugin')).toHaveLength(0)
  })

  it('opens the plugin page for a plugin asked for from outside Settings, with no dialog', async () => {
    await render()
    await act(async () =>
      requestPluginPreview({ marketplaceSourceId: SOURCE_ID, pluginKey: listing.pluginKey })
    )
    expect(document.querySelector('#plugin-detail-heading')?.textContent).toBe('Worktree Notes')
    expect(document.body.textContent).toContain('If you install Worktree Notes, it can:')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(buttons('Install plugin')).toHaveLength(0)
  })

  it('matches row action priority on crashed installed cards, even with an update available', async () => {
    installApi({
      listMarketplacePlugins: vi.fn().mockResolvedValue([{ ...listing, version: '2.0.0' }])
    })
    const { container } = await render([{ ...installedPlugin(), status: 'errored' }])
    expect(buttons('Restart')).toHaveLength(1)
    expect(buttons('Update 2.0.0')).toHaveLength(0)
    expect(container.querySelector('[data-plugin-row-name]')?.getAttribute('aria-label')).toContain(
      'Stopped'
    )
  })

  it('uses the shared update review for a single plugin', async () => {
    installApi({
      listMarketplacePlugins: vi.fn().mockResolvedValue([{ ...listing, version: '2.0.0' }])
    })
    const { onInstalled } = await render([installedPlugin()])
    await act(async () => button('Update 2.0.0').click())
    expect(document.body.textContent).toContain('Update plugins?')
    expect(document.querySelectorAll('[data-plugin-update]')).toHaveLength(1)
    expect(document.body.textContent).toContain('Source')
    expect(document.body.textContent).toContain(
      'full access to your files, network, and other processes'
    )
    await act(async () => button('Update 1 plugin').click())
    expect(onInstalled).toHaveBeenCalledWith([listing.pluginKey])
  })

  it('reaches Update all from the Updates tab', async () => {
    installApi({
      listMarketplacePlugins: vi.fn().mockResolvedValue([{ ...listing, version: '2.0.0' }]),
      previewMarketplaceUpdate: vi
        .fn()
        .mockResolvedValue({ ...preview, manifest: { ...preview.manifest, version: '2.0.0' } })
    })
    const { container } = await render([installedPlugin()])
    const updatesTab = Array.from(container.querySelectorAll('[role="tab"]')).find((tab) =>
      tab.textContent?.startsWith('Updates')
    )
    await act(async () => {
      updatesTab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })
    await act(async () => button('Update all…').click())
    expect(window.api.plugins.previewMarketplaceUpdate).toHaveBeenCalledWith({
      pluginKey: listing.pluginKey
    })
    expect(document.body.textContent).toContain('Update plugins?')
  })

  it('reports a failed catalog refresh even while catalogs are listed', async () => {
    installApi({ refreshMarketplaces: vi.fn().mockRejectedValue(new Error('offline')) })
    await render()
    const refresh = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh catalogs"]'
    )
    await act(async () => refresh?.click())
    expect(document.body.textContent).toContain("Couldn't refresh marketplaces. Try again.")
  })
})
