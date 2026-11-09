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

beforeEach(() => installApi())

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('PluginManager', () => {
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
