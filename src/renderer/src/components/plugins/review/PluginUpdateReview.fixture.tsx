import { XIcon } from 'lucide-react'
import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api/plugins/plugin-host-api'
import type { PluginUpdateAccessGrowth } from '../../../../../shared/plugins/approval/plugin-update-access-growth'
import {
  pluginManifestSchema,
  type PluginManifest
} from '../../../../../shared/plugins/manifest/plugin-manifest'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { Button } from '../../ui/button'
import { pluginListEntryFromInstalled } from '../list/plugin-list-entries'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import type { PluginUpdateReviewNotice } from '../../../../../shared/plugins/catalog/plugin-update-policy'
import { PluginUpdateReview } from './PluginUpdateReview'
import { PluginUpdateReviewToast } from './PluginUpdateReviewToast'

const editor = (id: string, extensions: string[]): Record<string, unknown> => ({
  id,
  title: 'Excalidraw',
  extensions,
  entry: 'editor/index.html',
  priority: 'default',
  frame: 'isolated'
})

function manifest(version: string, extra: Record<string, unknown> = {}): PluginManifest {
  return pluginManifestSchema.parse({
    manifestVersion: 2,
    id: 'orca-excalidraw',
    publisher: 'stablyai',
    name: 'Excalidraw',
    version,
    execution: 'sandboxed-ui',
    description: 'Draw and edit .excalidraw diagrams.',
    license: 'MIT',
    engines: { orca: '>=1.4.248' },
    capabilities: [],
    contributes: { customEditors: [editor('excalidraw', ['.excalidraw', '.excalidraw.json'])] },
    ...extra
  })
}

const installedManifest = manifest('2.1.0')

const installedExcalidraw: PluginHostListEntry = {
  pluginKey: 'stablyai.orca-excalidraw',
  name: 'Excalidraw',
  publisher: 'stablyai',
  version: '2.1.0',
  status: 'idle',
  execution: 'sandboxed-ui',
  consentFingerprint: 'installed',
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
    reference: 'https://github.com/stablyai/orca-plugins.git (plugins/excalidraw)',
    url: 'https://github.com/stablyai/orca-plugins.git',
    path: 'plugins/excalidraw',
    resolvedCommit: 'a'.repeat(40),
    contentHash: 'b'.repeat(64),
    marketplace: {
      reference: 'https://github.com/stablyai/orca-plugins.git',
      ref: 'main',
      resolvedCommit: 'c'
    }
  }
}
const entry = pluginListEntryFromInstalled(installedExcalidraw)

// A community plugin whose update adds a background worker: full access.
const installedMermaid: PluginHostListEntry = {
  ...installedExcalidraw,
  pluginKey: 'octocat.orca-mermaid-live',
  name: 'Mermaid Live',
  publisher: 'octocat',
  version: '0.4.0',
  official: false
}
const mermaidEntry = pluginListEntryFromInstalled(installedMermaid)

function preview(
  next: PluginManifest,
  accessGrowth: PluginUpdateAccessGrowth | undefined,
  official = true
): PluginMarketplaceHostInstallPreview {
  return {
    marketplaceSourceId: 'official',
    marketplaceName: 'Orca Plugins',
    marketplaceOwner: 'stablyai',
    marketplaceCommit: 'c',
    pluginKey: official ? entry.pluginKey : mermaidEntry.pluginKey,
    source: { kind: 'git', url: 'https://github.com/stablyai/orca-excalidraw.git', ref: 'v2.3.1' },
    resolvedCommit: 'd'.repeat(40),
    contentHash: 'e'.repeat(64),
    consentFingerprint: 'next',
    manifest: next,
    official,
    bundled: false,
    ...(accessGrowth ? { accessGrowth } : {})
  }
}

// Why a static frame: the real dialog portals out of the fixture frame. Same surface and footer.
function Frame({
  next,
  title = 'Review update to Excalidraw',
  children
}: {
  next?: PluginMarketplaceHostInstallPreview
  title?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="p-6">
      <div className="plugin-security-chrome relative grid gap-4 rounded-lg border border-black/14 bg-dialog-surface p-6 text-foreground dark:border-white/14">
        <XIcon className="absolute top-4 right-4 size-4 opacity-70" />
        <h2 className="text-lg leading-none font-semibold">{title}</h2>
        {next ? (
          <PluginUpdateReview entry={entry} preview={next} installedManifest={installedManifest} />
        ) : (
          children
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost">Cancel</Button>
          <Button>Approve &amp; update</Button>
        </div>
      </div>
    </div>
  )
}

function setup(): void {
  window.api.plugins.getInstalledManifest = async ({ pluginKey }) =>
    pluginKey === entry.pluginKey ? installedManifest : mermaidManifest('0.4.0')
}

function mermaidManifest(version: string, extra: Record<string, unknown> = {}): PluginManifest {
  return pluginManifestSchema.parse({
    manifestVersion: 2,
    id: 'orca-mermaid-live',
    publisher: 'octocat',
    name: 'Mermaid Live',
    version,
    execution: 'sandboxed-ui',
    description: 'Live Mermaid previews.',
    license: 'MIT',
    engines: { orca: '>=1.4.248' },
    capabilities: [],
    contributes: { customEditors: [editor('mermaid', ['.mmd'])] },
    ...extra
  })
}

const mermaidNext = preview(
  mermaidManifest('0.5.0', { execution: 'trusted-worker', main: 'worker.js' }),
  { capabilities: [], execution: 'trusted-worker', contributions: [] },
  false
)

const newEditors = manifest('2.3.1', {
  contributes: {
    customEditors: [
      editor('excalidraw', ['.excalidraw', '.excalidraw.json']),
      editor('excalidraw-svg', ['.excalidraw.svg']),
      editor('excalidraw-png', ['.excalidraw.png'])
    ]
  }
})

export const newFileTypes = defineFixture({
  width: 560,
  setup,
  render: () => (
    <Frame
      next={preview(newEditors, {
        capabilities: [],
        execution: null,
        contributions: ['customEditors']
      })}
    />
  )
})

export const uncompared = defineFixture({
  width: 560,
  setup,
  render: () => <Frame next={{ ...preview(newEditors, undefined), repositoryMoved: true }} />
})

export const unusableGrant = defineFixture({
  width: 560,
  setup,
  render: () => (
    <Frame
      next={preview(manifest('2.3.1'), {
        capabilities: ['terminal:send'],
        execution: null,
        contributions: []
      })}
    />
  )
})

const excalidrawNext = preview(newEditors, {
  capabilities: [],
  execution: null,
  contributions: ['customEditors']
})

export const grouped = defineFixture({
  width: 560,
  setup,
  render: () => (
    <Frame title="Review 2 updates">
      <div className="divide-y divide-border">
        {[
          { item: entry, next: excalidrawNext, held: installedManifest },
          { item: mermaidEntry, next: mermaidNext, held: mermaidManifest('0.4.0') }
        ].map(({ item, next, held }) => (
          <div key={item.pluginKey} className="py-3 first:pt-0">
            <PluginUpdateReview
              entry={item}
              preview={next}
              installedManifest={held}
              selection={{ checked: true, disabled: false, onCheckedChange: () => undefined }}
            />
          </div>
        ))}
      </div>
    </Frame>
  )
})

const notice = (installed: PluginHostListEntry, version: string): PluginUpdateReviewNotice => ({
  pluginKey: installed.pluginKey,
  name: installed.name,
  publisher: installed.publisher ?? '',
  version,
  reason: 'access'
})

function toastSetup(): void {
  setup()
  window.api.plugins.previewMarketplaceUpdate = async ({ pluginKey }) =>
    pluginKey === entry.pluginKey ? excalidrawNext : mermaidNext
  window.api.plugins.list = async () => [installedExcalidraw, installedMermaid]
}

export const toastOne = defineFixture({
  width: 420,
  setup: toastSetup,
  render: () => (
    <div className="p-6">
      <PluginUpdateReviewToast
        notices={[notice(installedExcalidraw, '2.3.1')]}
        onResolved={() => undefined}
        onResize={() => undefined}
      />
    </div>
  )
})

export const toastMany = defineFixture({
  width: 420,
  setup: toastSetup,
  render: () => (
    <div className="p-6">
      <PluginUpdateReviewToast
        notices={[notice(installedExcalidraw, '2.3.1'), notice(installedMermaid, '0.5.0')]}
        onResolved={() => undefined}
        onResize={() => undefined}
      />
    </div>
  )
})

// The community badge's trust advice, shown on hover.
export const communityHover = defineFixture({
  width: 560,
  setup,
  render: () => (
    <Frame title="Review update to Mermaid Live">
      <PluginUpdateReview
        entry={mermaidEntry}
        preview={mermaidNext}
        installedManifest={mermaidManifest('0.4.0')}
      />
    </Frame>
  ),
  interact: async (frame) => {
    frame.querySelector<HTMLElement>('[data-plugin-not-official]')?.focus()
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
})
