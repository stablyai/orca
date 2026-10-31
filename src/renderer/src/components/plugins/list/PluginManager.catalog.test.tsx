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
import {
  requestPluginPreview,
  requestPluginUpdateReview,
  usePluginPreviewRequestStore
} from '@/store/plugin-preview-request'
import { PluginManager } from './PluginManager'
import { PluginInstallTrustDialogHost } from '../dialogs/PluginInstallTrustDialog'
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
      agentHarnesses: [],
      themes: [],
      terminalThemes: [],
      iconThemes: [],
      syntaxes: [],
      customEditors: [],
      newFiles: []
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
    <>
      <PluginManager
        plugins={plugins}
        pluginsLoading={false}
        pluginsError={null}
        busyPluginKeys={new Set()}
        handlers={{
          onReview: vi.fn(),
          onToggleEnabled,
          onRestart: vi.fn(),
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
      <PluginInstallTrustDialogHost />
    </>
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

/** The open "Make sure you trust …" dialog, which must name this kind of warning. */
function trustDialog(kind: string): HTMLElement {
  const dialog = document.querySelector<HTMLElement>('[data-plugin-install-trust]')
  if (!dialog) {
    throw new Error('missing install trust dialog')
  }
  expect(dialog.dataset.pluginInstallTrust).toBe(kind)
  return dialog
}

function trustButton(dialog: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(dialog.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!match) {
    throw new Error(`missing ${label} in the trust dialog`)
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
            themes: [{ id: 'dusk', title: 'Dusk', path: 'themes/dusk.json' }]
          }
        }
      })
    })
    const { onInstalled } = await render()
    await act(async () => button('Install').click())
    const dialog = trustDialog('theme')
    expect(dialog.textContent).toContain('Make sure you trust example')
    expect(dialog.textContent).toContain(
      'This theme is from example, not Orca. Only install plugins from authors you trust.'
    )
    // Why Cancel holds focus: Enter on a link-opened page must never install unseen.
    expect(document.activeElement?.textContent).toBe('Cancel')
    expect(window.api.plugins.installMarketplacePlugin).not.toHaveBeenCalled()
    await act(async () => trustButton(dialog, 'Install').click())

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
    expect(document.body.textContent).toContain('Can access')
    expect(document.body.textContent).toContain(
      'Full access: runs as a normal program and can read your files, use the network and run other programs.'
    )

    await act(async () => button('Install & enable').click())
    const dialog = trustDialog('code')
    expect(dialog.textContent).toContain(
      'It runs the publisher’s code inside Orca, so only install it if you trust example.'
    )
    expect(dialog.textContent).toContain('example.com/notes')
    await act(async () => trustButton(dialog, 'Install').click())
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

  it('installs nothing when the trust dialog is cancelled', async () => {
    const { onInstalled } = await render()
    await act(async () => button('Review & install').click())
    await act(async () => button('Install & enable').click())
    await act(async () => trustButton(trustDialog('code'), 'Cancel').click())
    expect(document.querySelector('[data-plugin-install-trust]')).toBeNull()
    expect(window.api.plugins.installMarketplacePlugin).not.toHaveBeenCalled()
    expect(window.api.plugins.consent).not.toHaveBeenCalled()
    expect(onInstalled).not.toHaveBeenCalled()
  })

  it('still asks to trust the publisher on a page an install link opened', async () => {
    await render()
    await act(async () => {
      usePluginPreviewRequestStore.setState({
        link: { pluginKey: listing.pluginKey, catalog: { kind: 'url', source: source.source } }
      })
    })
    expect(document.querySelector('#plugin-detail-heading')?.textContent).toContain(
      'Worktree Notes'
    )
    await act(async () => button('Install & enable').click())
    const dialog = trustDialog('code')
    expect(document.activeElement?.textContent).toBe('Cancel')
    expect(window.api.plugins.installMarketplacePlugin).not.toHaveBeenCalled()
    await act(async () => trustButton(dialog, 'Install').click())
    expect(window.api.plugins.installMarketplacePlugin).toHaveBeenCalledWith(
      expect.objectContaining({ fromInstallLink: true })
    )
  })

  it('installs an official plugin without the trust dialog', async () => {
    const officialListing = { ...listing, official: true }
    installApi({
      listMarketplaces: vi.fn().mockResolvedValue([{ ...source, official: true }]),
      listMarketplacePlugins: vi.fn().mockResolvedValue([officialListing]),
      previewMarketplacePlugin: vi.fn().mockResolvedValue({ ...preview, official: true })
    })
    await render()
    await act(async () => button('Review & install').click())
    await act(async () => button('Install & enable').click())
    expect(document.querySelector('[data-plugin-install-trust]')).toBeNull()
    expect(window.api.plugins.installMarketplacePlugin).toHaveBeenCalledOnce()
  })

  it('offers a full-access release for review with no global switch', async () => {
    installApi({
      listMarketplacePlugins: vi.fn().mockResolvedValue([
        {
          ...listing,
          release: {
            version: '1.0.0',
            commit: PLUGIN_COMMIT,
            contentHash: 'd'.repeat(64),
            execution: 'trusted-worker',
            minimumOrca: '1.0.0',
            types: ['commands']
          }
        }
      ])
    })
    const { container } = await render()
    expect(container.textContent).toContain('Full access')
    expect(buttons('Review & install')).toHaveLength(1)
    expect(buttons('Turn on in settings')).toHaveLength(0)
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
    await render([installedPlugin(preview.contentHash)], undefined, onRemoveRequest)
    await act(async () => button('Remove…').click())

    expect(onRemoveRequest).toHaveBeenCalledWith(listing.pluginKey)
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
    expect(document.body.textContent).toContain('Already installed')
    expect(button('Update').disabled).toBe(true)
  })

  it('shows public install counts on the card and page only for community catalog plugins', async () => {
    const getInstallCounts = vi.fn().mockResolvedValue({ [listing.pluginKey]: 1234 })
    installApi({
      getInstallCounts,
      onInstallCountsChanged: vi.fn(() => () => undefined),
      listMarketplaces: vi.fn().mockResolvedValue([
        {
          ...source,
          source: { ...source.source, url: 'https://github.com/stablyai/orca-community-plugins' }
        }
      ])
    })
    await render()
    expect(getInstallCounts).toHaveBeenCalled()
    expect(document.querySelector('[data-plugin-install-count]')?.textContent).toContain(
      '1.2k installs'
    )
    await act(async () =>
      requestPluginPreview({ marketplaceSourceId: SOURCE_ID, pluginKey: listing.pluginKey })
    )
    expect(document.body.textContent).toContain('Installs1.2k')
  })

  it('hides install counts for a private catalog plugin', async () => {
    installApi({
      getInstallCounts: vi.fn().mockResolvedValue({ [listing.pluginKey]: 1234 }),
      onInstallCountsChanged: vi.fn(() => () => undefined)
    })
    await render()
    expect(document.querySelector('[data-plugin-install-count]')).toBeNull()
    expect(document.body.textContent).not.toContain('installs')
  })

  it('opens the plugin page for a plugin asked for from outside Settings, with no dialog', async () => {
    await render()
    await act(async () =>
      requestPluginPreview({ marketplaceSourceId: SOURCE_ID, pluginKey: listing.pluginKey })
    )
    expect(document.querySelector('#plugin-detail-heading')?.textContent).toBe('Worktree Notes')
    expect(document.body.textContent).toContain('Can access')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(buttons('Install plugin')).toHaveLength(0)
  })

  it('uses the shared update review for a single plugin', async () => {
    installApi({
      listMarketplacePlugins: vi.fn().mockResolvedValue([{ ...listing, version: '2.0.0' }]),
      previewMarketplaceUpdate: vi.fn().mockResolvedValue({
        ...preview,
        accessGrowth: { capabilities: [], execution: null, contributions: [] }
      })
    })
    const { onInstalled } = await render([installedPlugin()])
    await act(async () => button('Update 2.0.0').click())
    expect(document.body.textContent).toContain('Update 1 plugin')
    expect(document.querySelectorAll('[data-plugin-update]')).toHaveLength(1)
    // Why one line: nothing in this update asks for new access.
    expect(document.body.textContent).not.toContain('See all access')
    await act(async () => button('Update').click())
    expect(onInstalled).toHaveBeenCalledWith([listing.pluginKey])
  })

  it('opens a held update’s own review from the toast and approves nothing', async () => {
    installApi({
      listMarketplacePlugins: vi.fn().mockResolvedValue([{ ...listing, version: '2.0.0' }])
    })
    await render([installedPlugin()])
    await act(async () => requestPluginUpdateReview({ pluginKey: listing.pluginKey }))

    // Why re-read: the update pass refreshed main's catalogs after this pane loaded them.
    expect(window.api.plugins.listMarketplacePlugins).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('Review update to Worktree Notes')
    expect(buttons('Approve & update')).toHaveLength(1)
    expect(window.api.plugins.installMarketplacePlugin).not.toHaveBeenCalled()
    expect(window.api.plugins.consent).not.toHaveBeenCalled()
  })

  it('shows the Updates list for a grouped review, with nothing opened or approved', async () => {
    installApi({
      listMarketplacePlugins: vi.fn().mockResolvedValue([{ ...listing, version: '2.0.0' }])
    })
    await render([installedPlugin()])
    await act(async () => requestPluginUpdateReview({ pluginKey: null }))

    expect(buttons('Update all…')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('Review update to')
    expect(window.api.plugins.previewMarketplaceUpdate).not.toHaveBeenCalled()
    expect(window.api.plugins.installMarketplacePlugin).not.toHaveBeenCalled()
    expect(window.api.plugins.consent).not.toHaveBeenCalled()
  })
})
