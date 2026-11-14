import type { PluginMarketplaceHostListing } from '../../../../../preload/api/plugins/plugin-host-api'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { usePluginInstallCountsStore } from '@/store/plugins/installation/plugin-install-counts'
import {
  pluginListEntryFromInstalled,
  pluginListEntryFromListing,
  type PluginListEntry
} from '../list/plugin-list-entries'
import { PluginDetailPage } from './PluginDetailPage'

function communityListing(
  id: string,
  description: string,
  types: NonNullable<PluginMarketplaceHostListing['release']>['types']
): PluginMarketplaceHostListing {
  return {
    marketplaceSourceId: 'community',
    marketplaceName: 'Orca Community Plugins',
    marketplaceOwner: 'stablyai',
    marketplaceCommit: 'c',
    pluginKey: `octocat.${id}`,
    source: {
      kind: 'git',
      url: 'https://github.com/stablyai/orca-community-plugins.git',
      ref: 'main'
    },
    description,
    categories: ['themes'],
    official: false,
    bundled: false,
    license: 'MIT',
    updatedAt: '2026-11-02T00:00:00Z',
    release: {
      version: '1.1.2',
      commit: 'd'.repeat(40),
      contentHash: 'e'.repeat(64),
      execution: 'data',
      minimumOrca: '1.4.245',
      types,
      repository: `https://github.com/octocat/${id}.git`
    }
  }
}

function entryFor(listing: PluginMarketplaceHostListing): PluginListEntry {
  return {
    ...pluginListEntryFromListing(
      listing,
      [listing.marketplaceSourceId],
      'https://github.com/stablyai/orca-community-plugins.git'
    ),
    installCountEligible: true
  }
}

const main = entryFor(
  communityListing(
    'monospace-themes',
    'Monospace Light and Dark themes for Orca, with app colors, editor syntax highlighting, and matching terminal palettes.',
    ['app-theme', 'terminal-theme']
  )
)
const others = [
  entryFor(
    communityListing('paper-icons', 'Quiet file icons drawn on a paper grid.', ['icon-theme'])
  ),
  entryFor(
    communityListing('nord-terminal', 'Nord colors for every terminal pane.', ['terminal-theme'])
  )
]

function render(entries: readonly PluginListEntry[], entry = main): React.JSX.Element {
  return (
    <div className="p-8">
      <PluginDetailPage
        entry={entry}
        busy={false}
        orcaVersion="1.4.250"
        logsState={undefined}
        handlers={{
          onOpen: () => undefined,
          onReview: () => undefined,
          onToggleEnabled: () => undefined,
          onRestart: () => undefined,
          onViewLogs: () => undefined,
          onCheckUpdate: () => undefined,
          onRollbackRequest: () => undefined,
          onRemoveRequest: () => undefined
        }}
        fetchPreview={() => new Promise(() => undefined)}
        install={{ phaseOf: () => null, install: async () => undefined, dismiss: () => undefined }}
        refreshing={false}
        onConsent={async () => undefined}
        onBack={() => undefined}
        onOpenShortcuts={() => undefined}
        entries={{ installed: entry.installed ? [entry] : [], available: [main, ...entries] }}
        onOpenPlugin={() => undefined}
      />
    </div>
  )
}

function setup(): void {
  usePluginInstallCountsStore.setState({ counts: { [main.pluginKey]: 1280 } })
}

export const communityAuthor = defineFixture({ width: 1100, setup, render: () => render(others) })

export const narrow = defineFixture({ width: 640, setup, render: () => render([]) })

const installedMirror = pluginListEntryFromInstalled(
  {
    pluginKey: main.pluginKey,
    name: main.name,
    publisher: 'octocat',
    version: '1.1.2',
    description: main.description ?? undefined,
    status: 'disabled',
    execution: 'data',
    consentFingerprint: 'installed',
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
      reference:
        'https://github.com/stablyai/orca-community-plugins.git (plugins/monospace-themes)',
      url: 'https://github.com/stablyai/orca-community-plugins.git',
      path: 'plugins/monospace-themes',
      authorRepository: 'https://github.com/octocat/monospace-themes.git',
      resolvedCommit: 'd'.repeat(40),
      contentHash: 'e'.repeat(64),
      marketplace: {
        reference: 'https://github.com/stablyai/orca-community-plugins.git',
        ref: 'main',
        resolvedCommit: 'c'
      }
    }
  },
  main.listing
)

export const installedMirroredAuthor = defineFixture({
  width: 1100,
  setup,
  render: () => render(others, installedMirror)
})

const unknownAuthor = entryFor({
  ...main.listing!,
  release: { ...main.listing!.release!, repository: undefined }
})
export const unknownAuthorIdentity = defineFixture({
  width: 1100,
  setup,
  render: () => render(others, unknownAuthor)
})
