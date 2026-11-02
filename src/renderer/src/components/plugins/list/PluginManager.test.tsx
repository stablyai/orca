// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginHostListEntry,
  PluginMarketplaceHostListing,
  PluginMarketplaceHostSourceState
} from '../../../../../preload/api-types'
import { PLUGIN_GROUP_ROW_CAP, PluginManager } from './PluginManager'
import { usePluginPageNavigation } from '../state/use-plugin-page-navigation'

vi.mock('../../ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))
vi.mock('../dialogs/PluginMarketplaceSourceDialog', () => ({
  PluginMarketplaceSourceDialog: () => null
}))

const installedPlugin: PluginHostListEntry = {
  pluginKey: 'stablyai.orca-nord-theme',
  consentFingerprint: 'sha256-nord',
  name: 'Orca Nord',
  version: '1.0.0',
  publisher: 'stablyai',
  status: 'idle',
  needsReconsent: false,
  isDev: false,
  official: true,
  bundled: false,
  capabilities: [],
  panels: [],
  commands: [],
  hasWorker: false,
  restarts: 0,
  source: {
    kind: 'marketplace',
    reference: 'https://example.invalid/nord.git',
    resolvedCommit: 'a'.repeat(40),
    contentHash: 'b'.repeat(64)
  }
}

const source: PluginMarketplaceHostSourceState = {
  id: 'official',
  source: { kind: 'git', url: 'https://example.invalid/catalog.git', ref: 'main' },
  addedAt: 0,
  marketplace: {
    name: 'Orca Official Plugins',
    owner: 'stablyai',
    resolvedCommit: 'c',
    fetchedAt: 0
  },
  stale: false,
  official: true
}

function listing(pluginKey: string, extra: Partial<PluginMarketplaceHostListing> = {}) {
  const value: PluginMarketplaceHostListing = {
    marketplaceSourceId: 'official',
    marketplaceName: 'Orca Official Plugins',
    marketplaceOwner: 'stablyai',
    marketplaceCommit: 'c',
    pluginKey,
    source: { kind: 'git', url: 'https://example.invalid/plugin.git', ref: 'main' },
    description: `Description of ${pluginKey}`,
    categories: ['themes'],
    official: true,
    bundled: false,
    ...extra
  }
  return value
}

const catalogListings = [
  listing('stablyai.orca-nord-theme', {
    release: {
      version: '1.2.0',
      commit: 'd'.repeat(40),
      contentHash: 'e'.repeat(64),
      execution: 'data',
      minimumOrca: '1.4.0',
      types: ['app-theme'],
      name: 'Orca Nord'
    },
    license: 'MIT',
    changelog: 'Warmer comments.\n<b>not markup</b>'
  }),
  ...Array.from({ length: PLUGIN_GROUP_ROW_CAP + 2 }, (_, index) =>
    listing(`stablyai.extra-${index}`)
  )
]

let root: Root | null = null

function installApi(overrides: Record<string, unknown> = {}): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plugins: {
        listMarketplaces: vi.fn().mockResolvedValue([source]),
        listMarketplacePlugins: vi.fn().mockResolvedValue(catalogListings),
        refreshMarketplaces: vi.fn().mockResolvedValue(undefined),
        previewMarketplacePlugin: vi.fn().mockResolvedValue(null),
        getRollbackVersion: vi.fn().mockResolvedValue('1.0.0-rc.1'),
        getInstalledManifest: vi.fn().mockResolvedValue(null),
        ...overrides
      },
      updater: { getVersion: vi.fn().mockResolvedValue('1.4.214') },
      ui: { writeClipboardText: vi.fn() }
    }
  })
}

function Harness({ plugins }: { plugins: PluginHostListEntry[] }): React.JSX.Element {
  const page = usePluginPageNavigation()
  return (
    <PluginManager
      plugins={plugins}
      pluginsLoading={false}
      pluginsError={null}
      busyPluginKeys={new Set()}
      handlers={{
        onReview: vi.fn(),
        onToggleEnabled: vi.fn(),
        onRestart: vi.fn(),
        onRollbackRequest: vi.fn(),
        onRemoveRequest: vi.fn()
      }}
      onRefreshInstalled={vi.fn().mockResolvedValue(undefined)}
      onInstalled={vi.fn().mockResolvedValue(undefined)}
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

async function render(plugins: PluginHostListEntry[] = [installedPlugin]): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<Harness plugins={plugins} />)
  })
  return container
}

function buttonNamed(container: HTMLElement, name: string | RegExp): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((button) => {
    const label = button.getAttribute('aria-label') ?? button.textContent ?? ''
    return typeof name === 'string' ? label === name : name.test(label)
  })
}

beforeEach(() => installApi())

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('PluginManager', () => {
  it('lists each catalog plugin once, in catalog order, capped with Show all', async () => {
    const pastCap = { ...installedPlugin, pluginKey: 'stablyai.extra-13', name: 'Extra 13' }
    const container = await render([installedPlugin, pastCap])
    const catalogCards = (): Element[] =>
      Array.from(container.querySelectorAll('[data-plugin-key]'))
    const rows = catalogCards().map((row) => row.getAttribute('data-plugin-key'))
    // Why one grid: an installed catalog plugin keeps its card, so installing never moves it.
    expect(rows.filter((key) => key === 'stablyai.orca-nord-theme')).toHaveLength(1)
    // Why: an installed plugin past the cap keeps its card, so its switch never hides behind Show all.
    expect(rows).toHaveLength(PLUGIN_GROUP_ROW_CAP + 1)
    expect(rows).toContain('stablyai.extra-13')

    await act(async () =>
      buttonNamed(container, `Show all ${PLUGIN_GROUP_ROW_CAP + 3} plugins`)?.click()
    )
    expect(catalogCards()).toHaveLength(PLUGIN_GROUP_ROW_CAP + 3)
  })

  it('filters one list by install state, keeping local plugins and inline switches', async () => {
    const dev: PluginHostListEntry = {
      ...installedPlugin,
      pluginKey: 'local.dev-theme',
      name: 'Dev Theme',
      isDev: true,
      source: undefined
    }
    const container = await render([installedPlugin, dev])
    const keys = (): (string | null)[] =>
      Array.from(container.querySelectorAll('[data-plugin-key]'), (card) =>
        card.getAttribute('data-plugin-key')
      )
    const showFilter = (name: RegExp): void => {
      const tab = Array.from(container.querySelectorAll('[role="tab"]')).find((node) =>
        name.test(node.textContent ?? '')
      )
      act(() => {
        tab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      })
    }
    const nord = container.querySelector('[data-plugin-key="stablyai.orca-nord-theme"]')
    expect(nord?.querySelector('[data-plugin-installed-badge]')).not.toBeNull()
    expect(buttonNamed(container, 'Disable Orca Nord')?.getAttribute('role')).toBe('switch')
    expect(keys()).toContain('local.dev-theme')
    expect(container.textContent).toContain('not from a catalog')

    showFilter(/^Not installed/)
    expect(keys()).not.toContain('stablyai.orca-nord-theme')
    expect(keys()).not.toContain('local.dev-theme')
    expect(container.querySelector('[data-plugin-installed-badge]')).toBeNull()

    showFilter(/^Installed/)
    expect(keys().sort()).toEqual(['local.dev-theme', 'stablyai.orca-nord-theme'])
  })

  it('filters by one inline category chip at a time', async () => {
    installApi({
      listMarketplacePlugins: vi
        .fn()
        .mockResolvedValue([
          ...catalogListings,
          listing('stablyai.gleam', { categories: ['syntax'] })
        ])
    })
    const container = await render()
    const chip = Array.from(container.querySelectorAll('[data-slot="toggle-group-item"]')).find(
      (node) => node.textContent === 'Languages'
    )
    expect(chip?.querySelector('svg')).not.toBeNull()
    await act(async () => chip?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(
      Array.from(container.querySelectorAll('[data-plugin-key]'), (card) =>
        card.getAttribute('data-plugin-key')
      )
    ).toEqual(['stablyai.gleam'])
    // Why: single-select; clicking the active chip returns to every category.
    await act(async () => chip?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.querySelectorAll('[data-plugin-key]').length).toBeGreaterThan(1)
  })

  it('keeps installed plugins when the catalog never loads', async () => {
    installApi({ listMarketplaces: vi.fn().mockRejectedValue(new Error('offline')) })
    const container = await render()
    expect(container.querySelector('[data-plugin-key="stablyai.orca-nord-theme"]')).not.toBeNull()
    expect(container.textContent).toContain('Couldn’t load the plugin catalog.')
  })

  it('shows release notes as text, license and the rollback version on the plugin page', async () => {
    const container = await render()
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-plugin-key="stablyai.orca-nord-theme"] [data-plugin-row-name]'
        )
        ?.click()
    )
    expect(window.api.plugins.getRollbackVersion).toHaveBeenCalledWith({
      pluginKey: 'stablyai.orca-nord-theme'
    })
    expect(container.textContent).toContain('What’s new')
    expect(container.textContent).toContain('<b>not markup</b>')
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain('MIT')
    expect(container.textContent).toContain('1.0.0-rc.1')
  })
})
