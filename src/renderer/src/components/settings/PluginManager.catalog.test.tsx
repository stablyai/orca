// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginHostListEntry,
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing,
  PluginMarketplaceHostSourceState
} from '../../../../preload/api-types'
import { requestPluginPreview } from '@/store/plugin-preview-request'
import { PluginManager } from './PluginManager'
import { usePluginPageNavigation } from './use-plugin-page-navigation'

vi.mock('../ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))
vi.mock('../ui/dropdown-menu', () => ({
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
vi.mock('./PluginMarketplaceSourceDialog', () => ({ PluginMarketplaceSourceDialog: () => null }))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

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
  onInstalled
}: {
  plugins: PluginHostListEntry[]
  onInstalled: (keys: string | readonly string[]) => Promise<void>
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
        onToggleEnabled: vi.fn(),
        onRestart: vi.fn(),
        onViewLogs: vi.fn(),
        onRollbackRequest: vi.fn(),
        onRemoveRequest: vi.fn()
      }}
      onRefreshInstalled={vi.fn().mockResolvedValue(undefined)}
      onInstalled={onInstalled}
      logsByPlugin={{}}
      onShowLogs={vi.fn()}
      onOpenShortcuts={vi.fn()}
      page={page}
      sourcesOpen={false}
      setSourcesOpen={vi.fn()}
    />
  )
}

async function render(
  plugins: PluginHostListEntry[] = [],
  onInstalled = vi.fn().mockResolvedValue(undefined)
): Promise<{ container: HTMLDivElement; onInstalled: typeof onInstalled }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<Harness plugins={plugins} onInstalled={onInstalled} />)
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
  it('reviews the exact bytes it will install and hands the install to review', async () => {
    const { onInstalled } = await render()
    await act(async () => button('Install').click())

    expect(window.api.plugins.previewMarketplacePlugin).toHaveBeenCalledWith({
      marketplaceSourceId: SOURCE_ID,
      pluginKey: listing.pluginKey
    })
    await act(async () => button('Install plugin').click())
    expect(window.api.plugins.installMarketplacePlugin).toHaveBeenCalledWith({
      marketplaceSourceId: SOURCE_ID,
      marketplaceCommit: MARKETPLACE_COMMIT,
      pluginKey: listing.pluginKey,
      resolvedCommit: PLUGIN_COMMIT
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
    expect(window.api.plugins.previewMarketplacePlugin).not.toHaveBeenCalled()
  })

  it('says when an update preview matches the installed bytes', async () => {
    await render([installedPlugin(preview.contentHash)])
    await act(async () => button('Check for update').click())

    expect(window.api.plugins.previewMarketplaceUpdate).toHaveBeenCalledWith({
      pluginKey: listing.pluginKey
    })
    expect(document.body.textContent).toContain('This exact plugin content is already installed.')
    expect(buttons('Update plugin')).toHaveLength(0)
  })

  it('does not let an older preview response replace the latest one', async () => {
    const first = deferred<PluginMarketplaceHostInstallPreview>()
    const second = deferred<PluginMarketplaceHostInstallPreview>()
    const other: PluginMarketplaceHostListing = { ...listing, pluginKey: 'example.tasks' }
    installApi({
      listMarketplacePlugins: vi.fn().mockResolvedValue([listing, other]),
      previewMarketplacePlugin: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
    })
    await render()
    await act(async () => {
      const [a, b] = buttons('Install')
      a?.click()
      b?.click()
    })
    await act(async () =>
      second.resolve({
        ...preview,
        ...other,
        manifest: { ...preview.manifest, id: 'tasks', name: 'Worktree Tasks' }
      })
    )
    await act(async () => first.resolve(preview))
    expect(document.body.textContent).toContain('Worktree Tasks')
    expect(document.body.textContent).not.toContain('Worktree Notes')
  })

  it('opens a preview asked for from outside Settings, once', async () => {
    await render()
    await act(async () =>
      requestPluginPreview({ marketplaceSourceId: SOURCE_ID, pluginKey: listing.pluginKey })
    )
    expect(window.api.plugins.previewMarketplacePlugin).toHaveBeenCalledTimes(1)
    expect(buttons('Install plugin')).toHaveLength(1)
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
