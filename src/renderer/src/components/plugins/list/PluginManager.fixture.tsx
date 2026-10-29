import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { PluginMarketplaceHostListing } from '../../../../../preload/api-types'
import { PluginManager } from './PluginManager'
import { usePluginPageNavigation } from '../state/use-plugin-page-navigation'

const noop = (): void => {}
const done = async (): Promise<void> => {}
const listings: PluginMarketplaceHostListing[] = [
  ['midnight', 'Midnight', 'themes', 'A quiet dark theme for your workspace.'],
  ['nord', 'Nord', 'themes', 'A cool palette inspired by arctic colors.'],
  ['dracula', 'Dracula', 'themes', 'Familiar dark colors for your editor and terminal.'],
  ['gruvbox', 'Gruvbox', 'themes', 'Warm retro colors in light and dark.'],
  ['gleam', 'Gleam', 'syntax', 'Syntax highlighting for Gleam files.'],
  ['prisma', 'Prisma', 'syntax', 'Highlight your Prisma schemas.'],
  ['latex', 'LaTeX', 'syntax', 'Read and write TeX documents.'],
  ['excalidraw', 'Excalidraw', 'panels', 'Draw diagrams alongside your work.']
].map(([id, name, category, description]) => ({
  marketplaceSourceId: 'official',
  marketplaceName: 'Orca Official Plugins',
  marketplaceOwner: 'stablyai',
  marketplaceCommit: 'a'.repeat(40),
  pluginKey: `stablyai.${id}`,
  source: { kind: 'git', url: `https://example.invalid/${id}.git`, ref: 'main' },
  description,
  categories: [category ?? 'other'],
  official: true,
  bundled: false,
  release: {
    name,
    version: '1.0.0',
    commit: 'b'.repeat(40),
    contentHash: 'c'.repeat(64),
    execution: 'data',
    minimumOrca: '1.0.0',
    types: []
  }
}))

function Catalog(): React.JSX.Element {
  const page = usePluginPageNavigation()
  return (
    <PluginManager
      plugins={[]}
      pluginsLoading={false}
      pluginsError={null}
      busyPluginKeys={new Set()}
      handlers={{
        onReview: noop,
        onToggleEnabled: noop,
        onRestart: noop,
        onRollbackRequest: noop,
        onRemoveRequest: noop
      }}
      onRefreshInstalled={done}
      onInstalled={done}
      logsByPlugin={{}}
      onShowLogs={noop}
      onOpenShortcuts={noop}
      page={page}
      sourcesOpen={false}
      setSourcesOpen={noop}
      onConsent={done}
    />
  )
}

function setup(): void {
  const listMarketplaces = async () => [
    {
      id: 'official',
      source: { kind: 'git', url: 'https://example.invalid/catalog.git', ref: 'main' },
      addedAt: 0,
      marketplace: {
        name: 'Orca Official Plugins',
        owner: 'stablyai',
        resolvedCommit: 'a'.repeat(40),
        fetchedAt: 0
      },
      stale: false,
      official: true
    }
  ]
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ...window.api,
      plugins: {
        ...window.api.plugins,
        listMarketplaces,
        listMarketplacePlugins: async () => listings
      },
      updater: { ...window.api.updater, getVersion: async () => '1.4.245' }
    }
  })
}

async function waitForCards(frame: HTMLElement): Promise<void> {
  if (frame.querySelector('[data-plugin-key]')) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      observer.disconnect()
      reject(new Error('Catalog cards did not load'))
    }, 5000)
    const observer = new MutationObserver(() => {
      if (frame.querySelector('[data-plugin-key]')) {
        clearTimeout(timeout)
        observer.disconnect()
        resolve()
      }
    })
    observer.observe(frame, { childList: true, subtree: true })
  })
}

export const categories = defineFixture({
  width: 1100,
  setup,
  interact: waitForCards,
  render: () => <Catalog />
})
export const narrow = defineFixture({
  width: 390,
  setup,
  interact: waitForCards,
  render: () => <Catalog />
})
