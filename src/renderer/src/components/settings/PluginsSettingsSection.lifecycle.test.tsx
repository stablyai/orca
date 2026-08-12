// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/types'
import { PluginsSettingsSection } from './PluginsSettingsSection'

vi.mock('./SettingsSection', () => ({
  SettingsSection: ({
    children,
    headerAction
  }: {
    children: React.ReactNode
    headerAction: React.ReactNode
  }) => (
    <section>
      {headerAction}
      {children}
    </section>
  )
}))

vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect
  }: {
    children: React.ReactNode
    onSelect?: () => void
  }) => <button onClick={onSelect}>{children}</button>
}))

vi.mock('./PluginInstallDialog', () => ({ PluginInstallDialog: () => null }))
vi.mock('./PluginMarketplaceBrowser', () => ({
  PluginMarketplaceBrowser: ({
    renderInstalledContent
  }: {
    renderInstalledContent?: (search: string) => React.ReactNode
  }) => <>{renderInstalledContent?.('')}</>
}))
vi.mock('./PluginConsentDialog', () => ({
  PluginConsentDialog: ({
    plugin,
    onDecision
  }: {
    plugin: PluginHostListEntry | null
    onDecision: (key: string, reviewedFingerprint: string, decision: 'approve') => Promise<void>
  }) => {
    const [dirty, setDirty] = useState(false)
    return plugin ? (
      <>
        <button
          onClick={() =>
            void onDecision(plugin.pluginKey, plugin.consentFingerprint ?? '', 'approve')
          }
        >
          Approve
        </button>
        <button onClick={() => setDirty(true)}>Mark consent dirty</button>
        {dirty ? <span>Consent local state</span> : null}
      </>
    ) : null
  }
}))
vi.mock('./PluginRemoveDialog', () => ({
  PluginRemoveDialog: ({
    plugin,
    onConfirm
  }: {
    plugin: PluginHostListEntry | null
    onConfirm: (key: string) => void
  }) =>
    plugin ? <button onClick={() => onConfirm(plugin.pluginKey)}>Confirm remove</button> : null
}))
vi.mock('./PluginRollbackDialog', () => ({
  PluginRollbackDialog: ({
    plugin,
    onConfirm
  }: {
    plugin: PluginHostListEntry | null
    onConfirm: (key: string) => void
  }) =>
    plugin ? <button onClick={() => onConfirm(plugin.pluginKey)}>Confirm rollback</button> : null
}))

const plugin: PluginHostListEntry = {
  pluginKey: 'acme.notes',
  consentFingerprint: 'sha256-acme-notes',
  name: 'Notes',
  version: '1.0.0',
  publisher: 'acme',
  status: 'idle',
  needsReconsent: false,
  isDev: false,
  official: false,
  bundled: false,
  capabilities: [{ kind: 'panels', description: 'Add a Notes panel' }],
  panels: [],
  commands: [],
  hasWorker: false,
  restarts: 0
}

const secondPlugin: PluginHostListEntry = {
  ...plugin,
  pluginKey: 'acme.tasks',
  consentFingerprint: 'sha256-acme-tasks',
  name: 'Tasks'
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

async function renderSection(
  settings: GlobalSettings = { ...getDefaultSettings('/tmp'), pluginSystemEnabled: true },
  updateSettings = vi.fn().mockResolvedValue(undefined),
  mounted = true
): Promise<{ root: Root; container: HTMLDivElement; updateSettings: typeof updateSettings }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <PluginsSettingsSection
        mounted={mounted}
        settings={settings}
        updateSettings={updateSettings}
      />
    )
  })
  return { root, container, updateSettings }
}

function installApi(overrides: Record<string, unknown> = {}): {
  unsubscribe: ReturnType<typeof vi.fn>
} {
  const unsubscribe = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plugins: {
        list: vi.fn().mockResolvedValue([plugin]),
        onChanged: vi.fn().mockReturnValue(unsubscribe),
        refresh: vi.fn().mockResolvedValue([plugin]),
        setEnabled: vi.fn().mockResolvedValue([{ ...plugin, status: 'disabled' }]),
        remove: vi.fn().mockResolvedValue([]),
        getLogs: vi.fn().mockResolvedValue([]),
        consent: vi.fn().mockResolvedValue([plugin]),
        install: vi.fn(),
        rollbackMarketplacePlugin: vi.fn().mockResolvedValue({
          ok: true,
          pluginKey: plugin.pluginKey,
          version: plugin.version,
          contentHash: 'previous-content',
          consentFingerprint: plugin.consentFingerprint,
          resolvedCommit: 'previous-commit'
        }),
        ...overrides
      }
    }
  })
  return { unsubscribe }
}

beforeEach(() => installApi())

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('PluginsSettingsSection lifecycle', () => {
  it('defers discovery and its change listener until the pane is mounted', async () => {
    const settings = { ...getDefaultSettings('/tmp'), pluginSystemEnabled: true }
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    const { root } = await renderSection(settings, updateSettings, false)

    expect(window.api.plugins.list).not.toHaveBeenCalled()
    expect(window.api.plugins.onChanged).not.toHaveBeenCalled()

    await act(async () => {
      root.render(
        <PluginsSettingsSection mounted settings={settings} updateSettings={updateSettings} />
      )
    })

    expect(window.api.plugins.list).toHaveBeenCalledOnce()
    expect(window.api.plugins.onChanged).toHaveBeenCalledOnce()
  })

  it('suppresses stale lists and cleans up the change subscription', async () => {
    const first = deferred<PluginHostListEntry[]>()
    const second = deferred<PluginHostListEntry[]>()
    let onChanged: (() => void) | undefined
    const { unsubscribe } = installApi({
      list: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
      onChanged: vi.fn((callback: () => void) => {
        onChanged = callback
        return unsubscribe
      })
    })
    const { root, container } = await renderSection()

    act(() => onChanged?.())
    await act(async () => second.resolve([{ ...plugin, name: 'Newer Notes' }]))
    await act(async () => first.resolve([{ ...plugin, name: 'Older Notes' }]))

    expect(container.textContent).toContain('Newer Notes')
    expect(container.textContent).not.toContain('Older Notes')
    act(() => root.unmount())
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('persists the feature switch before refreshing discovery', async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    const { container } = await renderSection(
      { ...getDefaultSettings('/tmp'), pluginSystemEnabled: false },
      updateSettings
    )
    const featureSwitch = container.querySelector('[aria-labelledby="plugin-system-label"]')
    if (!featureSwitch) {
      throw new Error('missing feature switch')
    }
    expect(window.api.plugins.list).not.toHaveBeenCalled()

    await act(async () => click(featureSwitch))

    expect(updateSettings).toHaveBeenCalledWith({ pluginSystemEnabled: true })
    expect(window.api.plugins.refresh).toHaveBeenCalledOnce()
  })

  it('routes enablement and confirmed removal through plugin IPC', async () => {
    const { container } = await renderSection()
    const pluginSwitch = container.querySelector('[aria-label="Disable Notes"]')
    if (!pluginSwitch) {
      throw new Error('missing plugin switch')
    }

    await act(async () => click(pluginSwitch))
    expect(window.api.plugins.setEnabled).toHaveBeenCalledWith({
      pluginKey: plugin.pluginKey,
      enabled: false
    })
    await act(async () => click(pluginSwitch))
    expect(window.api.plugins.setEnabled).toHaveBeenLastCalledWith({
      pluginKey: plugin.pluginKey,
      enabled: true
    })

    const removeAction = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Remove'
    )
    if (!removeAction) {
      throw new Error('missing remove action')
    }
    await act(async () => click(removeAction))
    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Confirm remove'
    )
    if (!confirm) {
      throw new Error('missing remove confirmation')
    }
    await act(async () => click(confirm))
    expect(window.api.plugins.remove).toHaveBeenCalledWith({ pluginKey: plugin.pluginKey })
  })

  it('confirms marketplace rollback before invoking plugin IPC', async () => {
    const marketplacePlugin: PluginHostListEntry = {
      ...plugin,
      source: {
        kind: 'marketplace',
        reference: 'https://example.com/notes.git',
        resolvedCommit: 'current-commit',
        contentHash: 'current-content',
        marketplace: {
          reference: 'https://example.com/marketplace.git',
          resolvedCommit: 'marketplace-commit'
        }
      }
    }
    installApi({ list: vi.fn().mockResolvedValue([marketplacePlugin]) })
    const { container } = await renderSection()
    const rollbackAction = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Roll back'
    )
    if (!rollbackAction) {
      throw new Error('missing rollback action')
    }

    await act(async () => click(rollbackAction))
    expect(window.api.plugins.rollbackMarketplacePlugin).not.toHaveBeenCalled()
    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Confirm rollback'
    )
    if (!confirm) {
      throw new Error('missing rollback confirmation')
    }
    await act(async () => click(confirm))

    expect(window.api.plugins.rollbackMarketplacePlugin).toHaveBeenCalledWith({
      pluginKey: plugin.pluginKey
    })
  })

  it('accepts overlapping mutations in completion order without regressing final state', async () => {
    const firstToggle = deferred<PluginHostListEntry[]>()
    const secondToggle = deferred<PluginHostListEntry[]>()
    installApi({
      list: vi.fn().mockResolvedValue([plugin, secondPlugin]),
      setEnabled: vi
        .fn()
        .mockReturnValueOnce(firstToggle.promise)
        .mockReturnValueOnce(secondToggle.promise)
    })
    const { container } = await renderSection()
    const notesSwitch = container.querySelector<HTMLButtonElement>('[aria-label="Disable Notes"]')
    const tasksSwitch = container.querySelector<HTMLButtonElement>('[aria-label="Disable Tasks"]')
    if (!notesSwitch || !tasksSwitch) {
      throw new Error('missing plugin switches')
    }

    act(() => click(notesSwitch))
    act(() => click(tasksSwitch))
    expect(notesSwitch.disabled).toBe(true)
    expect(tasksSwitch.disabled).toBe(true)

    await act(async () => secondToggle.resolve([plugin, { ...secondPlugin, status: 'disabled' }]))

    expect(notesSwitch.disabled).toBe(true)
    expect(tasksSwitch.disabled).toBe(false)
    await act(async () =>
      firstToggle.resolve([
        { ...plugin, status: 'disabled' },
        { ...secondPlugin, status: 'disabled' }
      ])
    )
    expect(notesSwitch.disabled).toBe(false)
    expect(notesSwitch.getAttribute('aria-checked')).toBe('false')
    expect(tasksSwitch.getAttribute('aria-checked')).toBe('false')
  })

  it('fetches bounded logs only when their disclosure opens', async () => {
    const getLogs = vi.fn().mockResolvedValue([{ ts: 1, level: 'info', line: 'started' }])
    installApi({ getLogs })
    const { container } = await renderSection()
    expect(getLogs).not.toHaveBeenCalled()
    const viewLogs = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'View logs'
    )
    if (!viewLogs) {
      throw new Error('missing logs action')
    }

    await act(async () => click(viewLogs))

    expect(getLogs).toHaveBeenCalledWith({ pluginKey: plugin.pluginKey })
    expect(container.textContent).toContain('started')
  })

  it('shows supervised backoff as an enabled restarting plugin', async () => {
    installApi({
      list: vi.fn().mockResolvedValue([{ ...plugin, status: 'restarting', restarts: 1 }])
    })
    const { container } = await renderSection()
    const pluginSwitch = container.querySelector<HTMLButtonElement>('[aria-label="Disable Notes"]')

    expect(container.textContent).toContain('Restarting')
    expect(pluginSwitch?.getAttribute('aria-checked')).toBe('true')
  })

  it('prunes dialogs and stale logs after external removal and same-key reinstall', async () => {
    const removedList = deferred<PluginHostListEntry[]>()
    const reinstalledList = deferred<PluginHostListEntry[]>()
    const oldLogs = deferred<Awaited<ReturnType<typeof window.api.plugins.getLogs>>>()
    const freshLogs = deferred<Awaited<ReturnType<typeof window.api.plugins.getLogs>>>()
    const pendingPlugin = { ...plugin, status: 'pending' as const }
    let onChanged: (() => void) | undefined
    const unsubscribe = vi.fn()
    installApi({
      list: vi
        .fn()
        .mockResolvedValueOnce([pendingPlugin])
        .mockReturnValueOnce(removedList.promise)
        .mockReturnValueOnce(reinstalledList.promise),
      onChanged: vi.fn((callback: () => void) => {
        onChanged = callback
        return unsubscribe
      }),
      getLogs: vi.fn().mockReturnValueOnce(oldLogs.promise).mockReturnValueOnce(freshLogs.promise)
    })
    const { container } = await renderSection()
    const findButton = (label: string): HTMLButtonElement | undefined =>
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === label
      )

    act(() => click(findButton('Review & enable')!))
    act(() => click(findButton('Mark consent dirty')!))
    act(() => click(findButton('View logs')!))
    act(() => click(findButton('Remove')!))
    expect(container.textContent).toContain('Consent local state')
    expect(container.textContent).toContain('Confirm remove')

    act(() => onChanged?.())
    await act(async () => removedList.resolve([]))

    expect(container.textContent).not.toContain('Approve')
    expect(container.textContent).not.toContain('Confirm remove')
    act(() => onChanged?.())
    await act(async () => reinstalledList.resolve([pendingPlugin]))
    expect(container.textContent).not.toContain('Loading logs…')

    act(() => click(findButton('Review & enable')!))
    expect(container.textContent).not.toContain('Consent local state')
    act(() => click(findButton('View logs')!))
    await act(async () => freshLogs.resolve([{ ts: 2, level: 'info', line: 'fresh installation' }]))
    await act(async () => oldLogs.resolve([{ ts: 1, level: 'info', line: 'stale installation' }]))

    expect(container.textContent).toContain('fresh installation')
    expect(container.textContent).not.toContain('stale installation')
  })

  it('clears feature busy state and skips refresh when the setting write fails', async () => {
    const updateSettings = vi.fn().mockRejectedValue(new Error('disk write failed'))
    const { container } = await renderSection(
      { ...getDefaultSettings('/tmp'), pluginSystemEnabled: false },
      updateSettings
    )
    const featureSwitch = container.querySelector<HTMLButtonElement>(
      '[aria-labelledby="plugin-system-label"]'
    )
    if (!featureSwitch) {
      throw new Error('missing feature switch')
    }

    await act(async () => click(featureSwitch))

    expect(featureSwitch.disabled).toBe(false)
    expect(window.api.plugins.refresh).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Could not save plugin settings.')
  })

  it('persists verbatim development paths and refreshes discovery', async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    const { container } = await renderSection(undefined, updateSettings)
    const input = container.querySelector<HTMLInputElement>('details input')
    if (!input) {
      throw new Error('missing development path input')
    }
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'C:\\plugins\\demo'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const add = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add path'
    )
    if (!add) {
      throw new Error('missing add path action')
    }

    await act(async () => click(add))

    expect(updateSettings).toHaveBeenCalledWith({ devPluginPaths: ['C:\\plugins\\demo'] })
    expect(window.api.plugins.refresh).toHaveBeenCalled()
  })

  it('preserves development input and clears busy when adding a path fails', async () => {
    const updateSettings = vi.fn().mockRejectedValue(new Error('disk write failed'))
    const { container } = await renderSection(undefined, updateSettings)
    const input = container.querySelector<HTMLInputElement>('details input')
    if (!input) {
      throw new Error('missing development path input')
    }
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        '/plugins/demo'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const add = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add path'
    )
    if (!add) {
      throw new Error('missing add path action')
    }

    await act(async () => click(add))

    expect(input.value).toBe('/plugins/demo')
    expect(add.disabled).toBe(false)
    expect(window.api.plugins.refresh).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Could not save plugin settings.')
  })

  it('keeps a development path and handles a failed removal without rejection', async () => {
    const updateSettings = vi.fn().mockRejectedValue(new Error('disk write failed'))
    const settings = {
      ...getDefaultSettings('/tmp'),
      pluginSystemEnabled: true,
      devPluginPaths: ['/plugins/demo']
    }
    const { container } = await renderSection(settings, updateSettings)
    const remove = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Remove' && button.closest('details')
    )
    if (!remove) {
      throw new Error('missing development path remove action')
    }

    await act(async () => click(remove))

    expect(container.textContent).toContain('/plugins/demo')
    expect(remove.disabled).toBe(false)
    expect(window.api.plugins.refresh).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Could not save plugin settings.')
  })
})
