// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import type { PluginMarketplaceHostInstallPreview } from '../../../../../preload/api/plugins/plugin-host-api'
import { pluginManifestSchema } from '../../../../../shared/plugins/manifest/plugin-manifest'
import type { PluginCapabilityKind } from '../../../../../shared/plugins/capabilities/plugin-capabilities'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { PluginUpdateAllDialog } from './PluginUpdateAllDialog'

vi.mock('../../ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>
}))

function installed(pluginKey: string, kinds: string[]): PluginHostListEntry {
  return {
    pluginKey,
    consentFingerprint: null,
    name: pluginKey,
    version: '1.0.0',
    publisher: 'acme',
    status: 'idle',
    needsReconsent: false,
    isDev: false,
    official: false,
    bundled: false,
    capabilities: kinds.map((kind) => ({ kind, description: kind })),
    panels: [],
    commands: [],
    execution: 'data',
    hasWorker: false,
    restarts: 0
  }
}

function entry(pluginKey: string, kinds: string[]): PluginListEntry {
  const plugin = installed(pluginKey, kinds)
  return {
    pluginKey,
    name: pluginKey,
    publisher: 'acme',
    version: '1.0.0',
    description: null,
    official: false,
    categories: [],
    types: [],
    minimumOrca: null,
    catalogIds: [],
    autoUpdate: { updatedTo: null, needsReview: false },
    updatable: true,
    updateVersion: '1.1.0',
    installed: plugin,
    listing: null,
    verifiedSource: { kind: 'unverified' },
    alsoListedBy: []
  }
}

function preview(
  pluginKey: string,
  kinds: PluginCapabilityKind[],
  orca?: string
): PluginMarketplaceHostInstallPreview {
  return {
    marketplaceSourceId: 'official',
    marketplaceName: 'Official',
    marketplaceOwner: 'orca',
    marketplaceCommit: 'c',
    pluginKey,
    source: { kind: 'git', url: 'https://example.com/plugin.git', ref: 'main' },
    official: true,
    bundled: false,
    resolvedCommit: 'r',
    contentHash: 'h',
    consentFingerprint: 'f',
    accessGrowth: { capabilities: kinds, execution: null, contributions: [] },
    manifest: pluginManifestSchema.parse({
      manifestVersion: 1,
      id: 'test',
      publisher: 'acme',
      name: pluginKey,
      version: '1.1.0',
      capabilities: kinds.map((kind) => ({ kind })),
      pluginApi: 1,
      engines: { orca: orca ?? '>=1.0.0' }
    })
  }
}

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

function installApi(plugins: Record<string, unknown>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plugins: {
        getInstalledManifest: vi.fn().mockResolvedValue(null),
        consent: vi.fn().mockResolvedValue([]),
        ...plugins
      }
    }
  })
}

function workerUpdate(pluginKey: string, official: boolean): PluginMarketplaceHostInstallPreview {
  const next = preview(pluginKey, ['secrets:own'])
  return {
    ...next,
    official,
    manifest: { ...next.manifest, main: 'worker.js' },
    accessGrowth: {
      capabilities: ['secrets:own'],
      execution: 'trusted-worker',
      contributions: []
    }
  }
}

async function renderDialog(
  entries: PluginListEntry[],
  props: { onUpdated?: (keys: string[]) => Promise<void>; orcaVersion?: string } = {}
): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <PluginUpdateAllDialog
        open
        entries={entries}
        orcaVersion={props.orcaVersion}
        onClose={vi.fn()}
        onUpdated={props.onUpdated ?? vi.fn().mockResolvedValue(undefined)}
      />
    )
  })
  return container
}

function button(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === text
  )
}

describe('PluginUpdateAllDialog', () => {
  it('never approves bytes other than the ones it reviewed', async () => {
    const consent = vi.fn().mockResolvedValue([])
    installApi({
      previewMarketplaceUpdate: vi.fn().mockResolvedValue(workerUpdate('a', false)),
      installMarketplacePlugin: vi
        .fn()
        .mockResolvedValue({ ok: true, pluginKey: 'a', consentFingerprint: 'other' }),
      consent
    })
    const onUpdated = vi.fn().mockResolvedValue(undefined)
    const container = await renderDialog([entry('a', [])], { onUpdated })
    await act(async () => button(container, 'Approve & update')?.click())
    expect(consent).not.toHaveBeenCalled()
    // Why: main left it for review, which the page opens after the reload.
    expect(onUpdated).toHaveBeenCalledWith(['a'])
  })
})
