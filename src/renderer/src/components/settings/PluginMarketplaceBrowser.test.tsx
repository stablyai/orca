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
import { PluginMarketplaceBrowser } from './PluginMarketplaceBrowser'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => (resolve = done)), resolve }
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
      agents: []
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
    hasWorker: true,
    restarts: 0,
    source: {
      kind: 'marketplace',
      reference: listing.source.url,
      resolvedCommit: PLUGIN_COMMIT,
      contentHash,
      marketplace: {
        reference: source.source.url,
        resolvedCommit: MARKETPLACE_COMMIT
      }
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
        installMarketplacePlugin: vi.fn().mockResolvedValue({
          ok: true,
          pluginKey: listing.pluginKey,
          version: preview.manifest.version,
          contentHash: preview.contentHash,
          consentFingerprint: preview.consentFingerprint,
          resolvedCommit: preview.resolvedCommit
        }),
        addMarketplace: vi.fn(),
        removeMarketplace: vi.fn(),
        ...overrides
      }
    }
  })
}

async function renderBrowser(
  installedPlugins: PluginHostListEntry[] = [],
  onInstalled = vi.fn().mockResolvedValue(undefined)
): Promise<{ root: Root; container: HTMLDivElement; onInstalled: typeof onInstalled }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <PluginMarketplaceBrowser
        installedPlugins={installedPlugins}
        onInstalled={onInstalled}
        renderInstalledContent={() => <div>Installed content</div>}
      />
    )
  })
  return { root, container, onInstalled }
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!match) {
    throw new Error(`missing ${label} button`)
  }
  return match
}

beforeEach(() => installApi())

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('PluginMarketplaceBrowser', () => {
  it('reviews exact bytes and hands a successful install to the consent flow', async () => {
    const { root, container, onInstalled } = await renderBrowser()

    expect(container.textContent).toContain('Notes for active worktrees.')
    await act(async () => button('Install').click())

    expect(window.api.plugins.previewMarketplacePlugin).toHaveBeenCalledWith({
      marketplaceSourceId: SOURCE_ID,
      pluginKey: listing.pluginKey
    })
    // Why: provenance leads with a short badge; the source URL + full commit
    // are tucked behind an on-demand "Source" details popover.
    expect(document.body.textContent).toContain('Community')
    expect(
      Array.from(document.querySelectorAll('button')).some(
        (candidate) => candidate.textContent?.trim() === 'Source'
      )
    ).toBe(true)
    expect(document.body.textContent).toContain(
      'Read the name, branch, and terminal list of your focused worktree'
    )
    expect(document.body.textContent).toContain('full access to your files, network')
    expect(document.querySelector('[role="dialog"]')?.classList).toContain('plugin-security-chrome')

    await act(async () => button('Install plugin').click())

    expect(window.api.plugins.installMarketplacePlugin).toHaveBeenCalledWith({
      marketplaceSourceId: SOURCE_ID,
      marketplaceCommit: MARKETPLACE_COMMIT,
      pluginKey: listing.pluginKey,
      resolvedCommit: PLUGIN_COMMIT
    })
    expect(onInstalled).toHaveBeenCalledWith(listing.pluginKey)
    act(() => root.unmount())
  })

  it('disables a listing revoked by the safety list', async () => {
    installApi({
      listMarketplacePlugins: vi
        .fn()
        .mockResolvedValue([
          { ...listing, blockedByKillList: { reason: 'Known credential theft' } }
        ])
    })
    const { root, container } = await renderBrowser()
    const blocked = button('Blocked')

    expect(container.textContent).toContain('Known credential theft')
    expect(blocked.disabled).toBe(true)
    expect(window.api.plugins.previewMarketplacePlugin).not.toHaveBeenCalled()
    act(() => root.unmount())
  })

  it('detects when an update preview matches the installed content hash', async () => {
    const { root } = await renderBrowser([installedPlugin(preview.contentHash)])

    await act(async () => button('Check for update').click())

    expect(window.api.plugins.previewMarketplaceUpdate).toHaveBeenCalledWith({
      pluginKey: listing.pluginKey
    })
    expect(document.body.textContent).toContain('This exact plugin content is already installed.')
    // Why: an up-to-date preview offers no install action at all — only Close.
    expect(
      Array.from(document.querySelectorAll('button')).some(
        (candidate) => candidate.textContent?.trim() === 'Update plugin'
      )
    ).toBe(false)
    expect(button('Close')).toBeTruthy()
    act(() => root.unmount())
  })

  it('uses one catalog surface for available and installed plugins', async () => {
    const { root, container } = await renderBrowser([installedPlugin()])
    const installedFilter = Array.from(container.querySelectorAll('button')).find(
      (candidate) =>
        candidate.getAttribute('role') === 'tab' && candidate.textContent?.startsWith('Installed')
    )
    if (!installedFilter) {
      throw new Error('missing installed filter')
    }

    await act(async () => {
      installedFilter.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: false })
      )
    })

    expect(container.textContent).toContain('Installed content')
    expect(container.textContent).not.toContain('Notes for active worktrees.')
    act(() => root.unmount())
  })

  it('does not let an older preview response replace the latest selection', async () => {
    const first = deferred<PluginMarketplaceHostInstallPreview>()
    const second = deferred<PluginMarketplaceHostInstallPreview>()
    const otherListing: PluginMarketplaceHostListing = {
      ...listing,
      pluginKey: 'example.tasks',
      description: 'Tasks for active worktrees.'
    }
    const previewRequest = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    installApi({
      listMarketplacePlugins: vi.fn().mockResolvedValue([listing, otherListing]),
      previewMarketplacePlugin: previewRequest
    })
    const { root } = await renderBrowser()

    await act(async () => {
      const reviews = Array.from(document.querySelectorAll('button')).filter(
        (candidate) => candidate.textContent?.trim() === 'Install'
      )
      reviews[0]?.click()
      reviews[1]?.click()
    })
    await act(async () => {
      second.resolve({
        ...preview,
        ...otherListing,
        manifest: { ...preview.manifest, id: 'tasks', name: 'Worktree Tasks' }
      })
    })
    expect(document.body.textContent).toContain('Worktree Tasks')

    await act(async () => first.resolve(preview))

    expect(document.body.textContent).toContain('Worktree Tasks')
    expect(document.body.textContent).not.toContain('Worktree Notes')
    act(() => root.unmount())
  })
})
