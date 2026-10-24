// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { PluginsSettingsSection } from './PluginsSettingsSection'
import { applyPluginThemesNow } from '../plugins/state/plugin-theme-apply'

vi.mock('../plugins/state/plugin-theme-apply', () => ({
  applyPluginThemesNow: vi.fn().mockResolvedValue(false)
}))

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
    onSelect,
    disabled
  }: {
    children: React.ReactNode
    onSelect?: () => void
    disabled?: boolean
  }) => (
    <button disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuCheckboxItem: ({
    children,
    onCheckedChange
  }: {
    children: React.ReactNode
    onCheckedChange?: () => void
  }) => <button onClick={onCheckedChange}>{children}</button>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  DropdownMenuSeparator: () => null,
  DropdownMenuShortcut: () => null
}))

vi.mock('../ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))

vi.mock('../plugins/dialogs/PluginInstallDialog', () => ({ PluginInstallDialog: () => null }))
// Why mock the consent: review now happens on the plugin's page, where this section sits.
vi.mock('../plugins/review/PluginInstallConsent', () => ({
  PluginInstallConsent: ({ onConfirm }: { onConfirm: () => void }) => {
    const [dirty, setDirty] = useState(false)
    return (
      <>
        <button onClick={onConfirm}>Approve</button>
        <button onClick={() => setDirty(true)}>Mark consent dirty</button>
        {dirty ? <span>Consent local state</span> : null}
      </>
    )
  }
}))
vi.mock('../plugins/dialogs/PluginRemoveDialog', () => ({
  PluginRemoveDialog: ({
    plugin,
    onConfirm
  }: {
    plugin: PluginHostListEntry | null
    onConfirm: (key: string) => void
  }) =>
    plugin ? <button onClick={() => onConfirm(plugin.pluginKey)}>Confirm remove</button> : null
}))
vi.mock('../plugins/dialogs/PluginRollbackDialog', () => ({
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

async function openDevelopmentFolders(container: HTMLElement): Promise<void> {
  const open = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'Development folders…'
  )
  if (!open) {
    throw new Error('missing development folders action')
  }
  await act(async () => click(open))
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
        getRollbackVersion: vi.fn().mockResolvedValue(null),
        getInstalledManifest: vi.fn().mockResolvedValue(null),
        onChanged: vi.fn().mockReturnValue(unsubscribe),
        refresh: vi.fn().mockResolvedValue([plugin]),
        setEnabled: vi.fn().mockResolvedValue([{ ...plugin, status: 'disabled' }]),
        remove: vi.fn().mockResolvedValue([]),
        getLogs: vi.fn().mockResolvedValue([]),
        listMarketplaces: vi.fn().mockResolvedValue([]),
        listMarketplacePlugins: vi.fn().mockResolvedValue([]),
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
      },
      updater: { getVersion: vi.fn().mockResolvedValue('1.4.0') },
      ui: { writeClipboardText: vi.fn().mockResolvedValue(undefined) }
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

  it('offers turning plugins on only from the off state, not off from the menu', async () => {
    const { container: on } = await renderSection()
    expect(on.textContent).not.toContain('Turn off plugins')
    document.body.innerHTML = ''
    const { container: off } = await renderSection({
      ...getDefaultSettings('/tmp'),
      pluginSystemEnabled: false
    })
    expect(off.textContent).toContain('Turn on plugins')
  })

  it('persists the feature switch before refreshing discovery', async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    const { container } = await renderSection(
      { ...getDefaultSettings('/tmp'), pluginSystemEnabled: false },
      updateSettings
    )
    const turnOn = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Turn on plugins'
    )
    if (!turnOn) {
      throw new Error('missing turn-on action')
    }
    // Why: with plugins off the pane still lists what is installed, dimmed.
    expect(container.textContent).toContain('Notes')

    await act(async () => click(turnOn))

    expect(updateSettings).toHaveBeenCalledWith({ pluginSystemEnabled: true })
    expect(window.api.plugins.refresh).toHaveBeenCalledOnce()
  })

  it('clears feature busy state and skips refresh when the setting write fails', async () => {
    const updateSettings = vi.fn().mockRejectedValue(new Error('disk write failed'))
    const { container } = await renderSection(
      { ...getDefaultSettings('/tmp'), pluginSystemEnabled: false },
      updateSettings
    )
    const turnOn = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Turn on plugins'
    )
    if (!turnOn) {
      throw new Error('missing turn-on action')
    }

    await act(async () => click(turnOn))

    expect(turnOn.disabled).toBe(false)
    expect(window.api.plugins.refresh).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Could not save plugin settings.')
  })

  it('reports a failed save of the file-suggestion setting', async () => {
    const updateSettings = vi.fn().mockRejectedValue(new Error('disk write failed'))
    const { container } = await renderSection(undefined, updateSettings)
    const toggle = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Suggest plugins for unknown files')
    )
    await act(async () => click(toggle!))
    expect(updateSettings).toHaveBeenCalledWith({ pluginFileTypeSuggestions: false })
    expect(container.textContent).toContain('Could not save plugin settings.')
  })

  it('routes enablement and confirmed removal through plugin IPC', async () => {
    const { container } = await renderSection()
    const pluginSwitch = container.querySelector('[aria-label="Disable Notes"]')
    if (!pluginSwitch) {
      throw new Error('missing plugin switch')
    }

    vi.mocked(applyPluginThemesNow).mockClear()
    await act(async () => click(pluginSwitch))
    expect(window.api.plugins.setEnabled).toHaveBeenCalledWith({
      pluginKey: plugin.pluginKey,
      enabled: false
    })
    // Why: disabling falls back through the theme sync; only the Enable click applies themes.
    expect(applyPluginThemesNow).not.toHaveBeenCalled()
    await act(async () => click(pluginSwitch))
    expect(window.api.plugins.setEnabled).toHaveBeenLastCalledWith({
      pluginKey: plugin.pluginKey,
      enabled: true
    })
    expect(applyPluginThemesNow).toHaveBeenCalledExactlyOnceWith(plugin.pluginKey)

    const removeAction = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Remove…'
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

  it('opens review when enabling a plugin that was never approved', async () => {
    installApi({
      list: vi.fn().mockResolvedValue([{ ...plugin, status: 'disabled' }]),
      refresh: vi.fn().mockResolvedValue([{ ...plugin, status: 'disabled' }]),
      setEnabled: vi.fn().mockResolvedValue([{ ...plugin, status: 'pending' }])
    })
    const { container } = await renderSection()
    const pluginSwitch = container.querySelector('[aria-label="Enable Notes"]')
    if (!pluginSwitch) {
      throw new Error('missing plugin switch')
    }

    await act(async () => click(pluginSwitch))

    expect(window.api.plugins.setEnabled).toHaveBeenCalledWith({
      pluginKey: plugin.pluginKey,
      enabled: true
    })
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent === 'Approve'
      )
    ).toBe(true)
  })

  it('reopens a review after going back from it', async () => {
    installApi({ list: vi.fn().mockResolvedValue([{ ...plugin, status: 'pending' }]) })
    const { container } = await renderSection()
    const review = (): HTMLButtonElement | undefined =>
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Review'
      )
    await act(async () => click(review()!))
    expect(container.textContent).toContain('Approve')
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true }))
    )
    expect(container.textContent).not.toContain('Approve')
    await act(async () => click(review()!))
    expect(container.textContent).toContain('Approve')
  })

  it('shows what is true after a Restart fails halfway', async () => {
    const crashed = { ...plugin, status: 'errored' as const }
    const stopped = { ...plugin, status: 'disabled' as const }
    const list = vi.fn().mockResolvedValueOnce([crashed]).mockResolvedValue([stopped])
    installApi({
      list,
      setEnabled: vi
        .fn()
        .mockResolvedValueOnce([stopped])
        .mockRejectedValueOnce(new Error('worker failed to start'))
    })
    const { container } = await renderSection()
    const restart = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Restart'
    )
    if (!restart) {
      throw new Error('missing restart action')
    }

    await act(async () => click(restart))

    expect(list).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[aria-label="Enable Notes"]')).not.toBeNull()
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
    installApi({
      list: vi.fn().mockResolvedValue([marketplacePlugin]),
      getRollbackVersion: vi.fn().mockResolvedValue('0.9.0')
    })
    const { container } = await renderSection()
    expect(window.api.plugins.getRollbackVersion).toHaveBeenCalledWith({
      pluginKey: plugin.pluginKey
    })
    const rollbackAction = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Roll back to 0.9.0…'
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

  it('offers no rollback when no earlier version is kept', async () => {
    installApi({
      list: vi.fn().mockResolvedValue([
        {
          ...plugin,
          source: {
            kind: 'marketplace',
            reference: 'https://example.com/notes.git',
            resolvedCommit: 'current-commit',
            contentHash: 'current-content'
          }
        }
      ])
    })
    const { container } = await renderSection()
    expect(container.textContent).not.toContain('Roll back')
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
    installApi({ getLogs, list: vi.fn().mockResolvedValue([{ ...plugin, hasWorker: true }]) })
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
    const pendingPlugin = { ...plugin, status: 'pending' as const, hasWorker: true }
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

    // Why from the row: View logs opens the plugin's page, where its review and Remove… live.
    act(() => click(findButton('View logs')!))
    act(() => click(findButton('Mark consent dirty')!))
    act(() => click(findButton('Remove…')!))
    expect(container.textContent).toContain('Consent local state')
    expect(container.textContent).toContain('Confirm remove')

    act(() => onChanged?.())
    await act(async () => removedList.resolve([]))

    expect(container.textContent).not.toContain('Approve')
    expect(container.textContent).not.toContain('Confirm remove')
    act(() => onChanged?.())
    await act(async () => reinstalledList.resolve([pendingPlugin]))
    expect(container.textContent).not.toContain('Loading logs…')

    act(() => click(findButton('View logs')!))
    expect(container.textContent).toContain('Approve')
    expect(container.textContent).not.toContain('Consent local state')
    await act(async () => freshLogs.resolve([{ ts: 2, level: 'info', line: 'fresh installation' }]))
    await act(async () => oldLogs.resolve([{ ts: 1, level: 'info', line: 'stale installation' }]))

    expect(container.textContent).toContain('fresh installation')
    expect(container.textContent).not.toContain('stale installation')
  })

  it('persists verbatim development paths and refreshes discovery', async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    const { container } = await renderSection(undefined, updateSettings)
    await openDevelopmentFolders(container)
    const input = document.querySelector<HTMLInputElement>('#plugin-development-path')
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
    const add = Array.from(document.querySelectorAll('button')).find(
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
    await openDevelopmentFolders(container)
    const input = document.querySelector<HTMLInputElement>('#plugin-development-path')
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
    const add = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add path'
    )
    if (!add) {
      throw new Error('missing add path action')
    }

    await act(async () => click(add))

    expect(input.value).toBe('/plugins/demo')
    expect(add.disabled).toBe(false)
    expect(window.api.plugins.refresh).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Could not save plugin settings.')
  })

  it('keeps a development path and handles a failed removal without rejection', async () => {
    const updateSettings = vi.fn().mockRejectedValue(new Error('disk write failed'))
    const settings = {
      ...getDefaultSettings('/tmp'),
      pluginSystemEnabled: true,
      devPluginPaths: ['/plugins/demo']
    }
    const { container } = await renderSection(settings, updateSettings)
    await openDevelopmentFolders(container)
    const remove = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Remove' && button.closest('[role="dialog"]')
    )
    if (!remove) {
      throw new Error('missing development path remove action')
    }

    await act(async () => click(remove))

    expect(document.body.textContent).toContain('/plugins/demo')
    expect(remove.disabled).toBe(false)
    expect(window.api.plugins.refresh).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Could not save plugin settings.')
  })
})
