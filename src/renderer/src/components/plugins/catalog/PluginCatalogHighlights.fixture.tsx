import type { PluginMarketplaceHostListing } from '../../../../../preload/api-types'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { usePluginInstallCountsStore } from '@/store/plugins/installation/plugin-install-counts'
import { pluginListEntryFromListing, type PluginListEntry } from '../list/plugin-list-entries'
import type { CatalogCardHandlers } from './PluginCatalogGroups'
import { PluginCatalogHighlights } from './PluginCatalogHighlights'

const HOUR_MS = 60 * 60 * 1000

function entry(
  pluginKey: string,
  name: string,
  description: string,
  categories: string[],
  extra: Partial<PluginMarketplaceHostListing> = {}
): PluginListEntry {
  const official = pluginKey.startsWith('stablyai.')
  return {
    ...pluginListEntryFromListing({
      marketplaceSourceId: official ? 'official' : 'community',
      marketplaceName: official ? 'Orca Official Plugins' : 'Orca Community Plugins',
      marketplaceOwner: 'stablyai',
      marketplaceCommit: 'c'.repeat(40),
      pluginKey,
      source: { kind: 'git', url: `https://github.com/${pluginKey}.git`, ref: 'main' },
      description,
      categories,
      official,
      bundled: false,
      name,
      ...extra
    }),
    installCountEligible: true
  }
}

const addedHoursAgo = (hours: number): string =>
  new Date(Date.now() - hours * HOUR_MS).toISOString()

const entries = [
  entry(
    'stablyai.orca-ayu-theme',
    'Ayu for Orca',
    'Simple, bright and elegant: Ayu Light, Mirage and Dark app themes with matching code and terminal colors.',
    ['themes']
  ),
  entry(
    'stablyai.orca-catppuccin-theme',
    'Catppuccin for Orca',
    'Soothing pastel app themes for Orca: Mocha for dark mode and Latte for light mode.',
    ['themes']
  ),
  entry(
    'stablyai.orca-excalidraw',
    'Excalidraw',
    'Draw and edit .excalidraw diagrams, and .excalidraw.svg and .excalidraw.png images, right in Orca.',
    ['editors']
  ),
  entry(
    'stablyai.orca-material-icons',
    'Material Icon Theme for Orca',
    'Colorful Material file icons for about 470 file types and names, with a variant for light themes.',
    ['icons']
  ),
  entry(
    'thailoc-dev.dev-toolbox',
    'Dev Toolbox',
    '49 offline developer tools in the sidebar: JWT, certificates, Docker run to Compose, JSON diff.',
    ['panels']
  ),
  entry(
    'ibazylchuk.openspec-board',
    'OpenSpec Board',
    'Kanban board for OpenSpec spec-driven development: every change by stage with task progress.',
    ['panels'],
    { addedAt: addedHoursAgo(1), release: undefined }
  ),
  entry(
    'gino8080.git-overview',
    'Multi-Repo Git Overview',
    'For a folder of independent git repos: see which have pending changes or are behind.',
    ['panels'],
    { addedAt: addedHoursAgo(2) }
  ),
  entry(
    'hilbana.hilbana',
    'Hilbana',
    'Your Hilbana issues inside Orca: list, filters, search, detail, state changes and comments.',
    ['panels'],
    { addedAt: addedHoursAgo(2.5) }
  ),
  entry(
    'ebbop.italiano',
    'Italiano',
    'Traduzione italiana dell’interfaccia di Orca.',
    ['language-packs'],
    { addedAt: addedHoursAgo(30) }
  ),
  entry(
    'gongxliang.claude-paper',
    'Claude Paper',
    'Warm paper light and charcoal dark for Orca: chat, code, diffs and terminal.',
    ['themes'],
    { addedAt: addedHoursAgo(80) }
  )
]

const handlers: CatalogCardHandlers = {
  install: { phaseOf: () => null, install: async () => undefined, dismiss: () => undefined },
  prefetch: { intend: () => undefined, cancel: () => undefined },
  openEntry: () => undefined,
  installedHandlers: {
    onOpen: () => undefined,
    onReview: () => undefined,
    onToggleEnabled: () => undefined,
    onRestart: () => undefined,
    onViewLogs: () => undefined,
    onCheckUpdate: () => undefined,
    onRollbackRequest: () => undefined,
    onRemoveRequest: () => undefined
  },
  busyPluginKeys: new Set(),
  orcaVersion: '1.4.256',
  refreshing: false
}

function setup(): void {
  usePluginInstallCountsStore.setState({
    counts: {
      'stablyai.orca-ayu-theme': 2467,
      'stablyai.orca-catppuccin-theme': 2134,
      'stablyai.orca-excalidraw': 2384,
      'stablyai.orca-material-icons': 1576,
      'thailoc-dev.dev-toolbox': 422
    }
  })
}

function render(): React.JSX.Element {
  return (
    <div className="@container/plugin-catalog space-y-8 p-6">
      <PluginCatalogHighlights
        entries={entries}
        orcaVersion="1.4.256"
        cardHandlers={handlers}
        onSeeAllNew={() => undefined}
      />
    </div>
  )
}

export const wide = defineFixture({ width: 1180, setup, render })

export const narrow = defineFixture({ width: 640, setup, render })
