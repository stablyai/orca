// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginHostListEntry,
  PluginMarketplaceHostInstallPreview
} from '../../../../../preload/api-types'
import { pluginManifestSchema } from '../../../../../shared/plugins/manifest/plugin-manifest'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { PluginUpdateAllDialog } from './PluginUpdateAllDialog'
import { newAccess } from '../review/PluginUpdateCandidate'

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
    updatable: true,
    updateVersion: '1.1.0',
    installed: plugin,
    listing: null
  }
}

function preview(
  pluginKey: string,
  kinds: string[],
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
  Object.defineProperty(window, 'api', { configurable: true, value: { plugins } })
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
  it('warns before a content-only plugin becomes a trusted worker with no added capabilities', async () => {
    const worker = preview('a', [])
    worker.manifest = { ...worker.manifest, main: 'worker.js' }
    installApi({ previewMarketplaceUpdate: vi.fn().mockResolvedValue(worker) })
    const container = await renderDialog([entry('a', [])])
    expect(container.textContent).toContain(
      'full access to your files, network, and other processes'
    )
    expect(container.textContent).not.toContain('No new access')
    expect(container.textContent).not.toContain('None of these updates asks for new access')
  })

  it('names only access the installed version lacks', () => {
    expect(newAccess(entry('a', ['storage']), preview('a', ['storage', 'secrets']))).toEqual([
      'secrets'
    ])
  })

  it('reviews every update in one dialog and installs only the ticked ones', async () => {
    const installMarketplacePlugin = vi.fn().mockResolvedValue({ ok: true, pluginKey: 'b' })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        plugins: {
          previewMarketplaceUpdate: vi.fn(({ pluginKey }: { pluginKey: string }) =>
            Promise.resolve(preview(pluginKey, pluginKey === 'a' ? ['secrets'] : []))
          ),
          installMarketplacePlugin
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
    expect(container.textContent).toContain('Updates that ask for new access are expanded below.')
    expect(container.textContent).toContain('New access:')

    const first = container.querySelector<HTMLButtonElement>('#plugin-update-a')
    await act(async () => first?.click())
    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Update 1 plugin'
    )
    await act(async () => confirm?.click())

    expect(installMarketplacePlugin).toHaveBeenCalledTimes(1)
    expect(installMarketplacePlugin).toHaveBeenCalledWith(
      expect.objectContaining({ pluginKey: 'b' })
    )
    expect(onUpdated).toHaveBeenCalledWith(['b'])
  })

  it('reads each update once, however often the parent re-renders', async () => {
    const previewMarketplaceUpdate = vi.fn(({ pluginKey }: { pluginKey: string }) =>
      Promise.resolve(preview(pluginKey, []))
    )
    installApi({ previewMarketplaceUpdate, installMarketplacePlugin: vi.fn() })
    const onUpdated = vi.fn().mockResolvedValue(undefined)
    await renderDialog([entry('a', []), entry('b', [])], { onUpdated })
    for (let index = 0; index < 3; index += 1) {
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
    }
    expect(previewMarketplaceUpdate).toHaveBeenCalledTimes(2)
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

    await act(async () => button(container, 'Update 2 plugins')?.click())
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
    await act(async () => button(container, 'Update 2 plugins')?.click())
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

  it('says nothing was updated when every update fails', async () => {
    installApi({
      previewMarketplaceUpdate: vi.fn(({ pluginKey }: { pluginKey: string }) =>
        Promise.resolve(preview(pluginKey, []))
      ),
      installMarketplacePlugin: vi.fn().mockRejectedValue(new Error('offline'))
    })
    const onUpdated = vi.fn().mockResolvedValue(undefined)
    const container = await renderDialog([entry('a', []), entry('b', [])], { onUpdated })

    await act(async () => button(container, 'Update 2 plugins')?.click())
    expect(container.textContent).toContain('Couldn’t update a, b. Nothing was updated.')
    expect(container.textContent).not.toContain('The others were updated.')
    expect(onUpdated).not.toHaveBeenCalled()
  })

  it('lists an update that needs a newer Orca without offering it', async () => {
    installApi({
      previewMarketplaceUpdate: vi.fn(({ pluginKey }: { pluginKey: string }) =>
        Promise.resolve(preview(pluginKey, [], pluginKey === 'a' ? '>=9.0.0' : '>=1.0.0'))
      ),
      installMarketplacePlugin: vi.fn()
    })
    const container = await renderDialog([entry('a', []), entry('b', [])], {
      orcaVersion: '1.4.0'
    })

    expect(container.textContent).toContain('Needs Orca 9.0.0 or later.')
    const checkbox = container.querySelector<HTMLButtonElement>('#plugin-update-a')
    expect(checkbox?.disabled).toBe(true)
    expect(checkbox?.getAttribute('aria-checked')).toBe('false')
    expect(button(container, 'Update 1 plugin')).toBeDefined()
  })
})
