// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginHostListEntry,
  PluginMarketplaceHostInstallPreview
} from '../../../../../preload/api-types'
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

function reviewButton(container: HTMLElement, pluginKey: string): HTMLButtonElement | undefined {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(`[data-plugin-update="${pluginKey}"] button`)
  ).find((candidate) => candidate.textContent === 'Review')
}

function button(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === text
  )
}

describe('PluginUpdateAllDialog', () => {
  it('lists every update in one dialog and bulk-installs only those asking for nothing new', async () => {
    const installMarketplacePlugin = vi.fn().mockResolvedValue({ ok: true, pluginKey: 'b' })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        plugins: {
          previewMarketplaceUpdate: vi.fn(({ pluginKey }: { pluginKey: string }) =>
            Promise.resolve(preview(pluginKey, pluginKey === 'a' ? ['secrets:own'] : []))
          ),
          installMarketplacePlugin,
          getInstalledManifest: vi.fn().mockResolvedValue(null)
        }
      }
    })
    const onUpdated = vi.fn().mockResolvedValue(undefined)
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <PluginUpdateAllDialog
          open
          entries={[entry('a', []), entry('b', [])]}
          onClose={vi.fn()}
          onUpdated={onUpdated}
        />
      )
    })
    expect(container.querySelector('h2')?.textContent).toBe('Update 2 plugins')
    expect(container.textContent).toContain('New: Store its own encrypted secrets')
    expect(container.querySelector('[data-plugin-update="b"]')?.textContent).toBe('b1.0.0 → 1.1.0')

    // Why no checkbox: an update that grows access is never part of the bulk Update.
    expect(container.querySelector('#plugin-update-a')).toBeNull()
    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Update'
    )
    await act(async () => confirm?.click())

    expect(installMarketplacePlugin).toHaveBeenCalledTimes(1)
    expect(installMarketplacePlugin).toHaveBeenCalledWith(
      expect.objectContaining({ pluginKey: 'b' })
    )
    expect(onUpdated).toHaveBeenCalledWith(['b'])
  })

  it('names what failed, keeps what updated, and retries only the failures', async () => {
    const installMarketplacePlugin = vi.fn(({ pluginKey }: { pluginKey: string }) =>
      Promise.resolve(pluginKey === 'a' ? { ok: false, error: 'boom' } : { ok: true, pluginKey })
    )
    installApi({
      previewMarketplaceUpdate: vi.fn(({ pluginKey }: { pluginKey: string }) =>
        Promise.resolve(preview(pluginKey, []))
      ),
      installMarketplacePlugin
    })
    const onUpdated = vi.fn().mockResolvedValue(undefined)
    const container = await renderDialog([entry('a', []), entry('b', [])], { onUpdated })

    await act(async () => button(container, 'Update')?.click())
    expect(container.textContent).toContain('Couldn’t update a. The others were updated.')
    expect(onUpdated).toHaveBeenCalledWith(['b'])
    expect(container.querySelector('[data-plugin-update="b"]')?.textContent).toContain('Updated')

    installMarketplacePlugin.mockClear()
    await act(async () => button(container, 'Try again')?.click())
    expect(installMarketplacePlugin).toHaveBeenCalledTimes(1)
    expect(installMarketplacePlugin).toHaveBeenCalledWith(
      expect.objectContaining({ pluginKey: 'a' })
    )
    // Why: "b" updated on the first pass, so a second failure isn't "nothing was updated".
    expect(container.textContent).toContain('Couldn’t update a. The others were updated.')
  })

  it('keeps the set it opened with while the list reloads mid-run', async () => {
    const previewMarketplaceUpdate = vi.fn(({ pluginKey }: { pluginKey: string }) =>
      Promise.resolve(preview(pluginKey, []))
    )
    installApi({
      previewMarketplaceUpdate,
      installMarketplacePlugin: vi.fn(({ pluginKey }: { pluginKey: string }) =>
        Promise.resolve(pluginKey === 'a' ? { ok: false, error: 'boom' } : { ok: true, pluginKey })
      )
    })
    const onUpdated = vi.fn().mockResolvedValue(undefined)
    const container = await renderDialog([entry('a', []), entry('b', [])], { onUpdated })
    await act(async () => button(container, 'Update')?.click())
    // Why: after "b" updates, the reloaded list no longer has it among pending updates.
    await act(async () => {
      root?.render(
        <PluginUpdateAllDialog
          open
          entries={[entry('a', [])]}
          onClose={vi.fn()}
          onUpdated={onUpdated}
        />
      )
    })
    expect(previewMarketplaceUpdate).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[data-plugin-update="b"]')?.textContent).toContain('Updated')
  })

  it('approves an update that grows access only from its own before/after review', async () => {
    const installMarketplacePlugin = vi.fn(({ pluginKey }: { pluginKey: string }) =>
      Promise.resolve({ ok: true, pluginKey, consentFingerprint: 'f' })
    )
    const consent = vi.fn().mockResolvedValue([])
    installApi({
      previewMarketplaceUpdate: vi.fn(({ pluginKey }: { pluginKey: string }) =>
        Promise.resolve(pluginKey === 'a' ? workerUpdate('a', false) : preview(pluginKey, []))
      ),
      installMarketplacePlugin,
      consent
    })
    const onUpdated = vi.fn().mockResolvedValue(undefined)
    const container = await renderDialog([entry('a', ['storage:own']), entry('b', [])], {
      onUpdated
    })

    await act(async () => reviewButton(container, 'a')?.click())
    expect(container.querySelector('h2')?.textContent).toBe('Review update to a')
    const review = container.querySelector('[data-plugin-update-review="a"]')
    expect(review?.textContent).toContain('BeforeContent onlyStore its own data')
    expect(review?.textContent).toContain('New: Full access')
    expect(review?.textContent).toContain('New: Store its own encrypted secrets')
    expect(review?.textContent).toContain('Not an official plugin:')
    expect(installMarketplacePlugin).not.toHaveBeenCalled()

    await act(async () => button(container, 'Approve & update')?.click())
    expect(installMarketplacePlugin).toHaveBeenCalledTimes(1)
    expect(installMarketplacePlugin).toHaveBeenCalledWith(
      expect.objectContaining({ pluginKey: 'a' })
    )
    expect(consent).toHaveBeenCalledWith({
      pluginKey: 'a',
      reviewedFingerprint: 'f',
      decision: 'approve'
    })
    expect(onUpdated).toHaveBeenCalledWith(['a'])
    // Why back to the list: "b" still waits for the bulk Update.
    expect(container.querySelector('[data-plugin-update="a"]')?.textContent).toContain('Updated')
  })

  it('opens a lone content-only update from a moved repository to its own review', async () => {
    const installMarketplacePlugin = vi.fn(({ pluginKey }: { pluginKey: string }) =>
      Promise.resolve({ ok: true, pluginKey, consentFingerprint: 'f', needsReview: true })
    )
    const consent = vi.fn().mockResolvedValue([])
    installApi({
      previewMarketplaceUpdate: vi.fn(() =>
        Promise.resolve({
          ...preview('a', []),
          source: { kind: 'git', url: 'https://example.com/someone-else/theme.git', ref: 'main' },
          repositoryMoved: true as const
        })
      ),
      installMarketplacePlugin,
      consent
    })
    const theme = entry('a', [])
    theme.installed!.source = {
      kind: 'marketplace',
      reference: 'https://example.com/acme/theme.git',
      resolvedCommit: 'r0',
      contentHash: 'h0'
    }
    const container = await renderDialog([theme])

    // Same access, so only the source line explains why this one asks again.
    expect(container.querySelector('h2')?.textContent).toBe('Review update to a')
    expect(container.textContent).toContain(
      'New source: https://example.com/someone-else/theme.git (was https://example.com/acme/theme.git)'
    )
    expect(installMarketplacePlugin).not.toHaveBeenCalled()
    await act(async () => button(container, 'Approve & update')?.click())
    expect(consent).toHaveBeenCalledWith({
      pluginKey: 'a',
      reviewedFingerprint: 'f',
      decision: 'approve'
    })
  })

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
