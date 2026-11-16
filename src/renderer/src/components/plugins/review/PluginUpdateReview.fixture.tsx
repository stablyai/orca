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
import { PluginUpdateReview } from './PluginUpdateReview'

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

const entry = pluginListEntryFromInstalled({
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
})

function preview(
  next: PluginManifest,
  accessGrowth: PluginUpdateAccessGrowth | undefined
): PluginMarketplaceHostInstallPreview {
  return {
    marketplaceSourceId: 'official',
    marketplaceName: 'Orca Plugins',
    marketplaceOwner: 'stablyai',
    marketplaceCommit: 'c',
    pluginKey: entry.pluginKey,
    source: { kind: 'git', url: 'https://github.com/stablyai/orca-excalidraw.git', ref: 'v2.3.1' },
    resolvedCommit: 'd'.repeat(40),
    contentHash: 'e'.repeat(64),
    consentFingerprint: 'next',
    manifest: next,
    official: true,
    bundled: false,
    ...(accessGrowth ? { accessGrowth } : {})
  }
}

// Why a static frame: the real dialog portals out of the fixture frame. Same surface and footer.
function Frame({ next }: { next: PluginMarketplaceHostInstallPreview }): React.JSX.Element {
  return (
    <div className="p-6">
      <div className="plugin-security-chrome relative grid gap-4 rounded-lg border border-black/14 bg-dialog-surface p-6 text-foreground dark:border-white/14">
        <XIcon className="absolute top-4 right-4 size-4 opacity-70" />
        <h2 className="text-lg leading-none font-semibold">Review update to Excalidraw</h2>
        <PluginUpdateReview entry={entry} preview={next} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost">Cancel</Button>
          <Button>Approve &amp; update</Button>
        </div>
      </div>
    </div>
  )
}

function setup(): void {
  window.api.plugins.getInstalledManifest = async () => installedManifest
}

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
