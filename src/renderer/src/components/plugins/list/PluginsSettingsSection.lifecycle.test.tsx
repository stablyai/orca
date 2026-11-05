// @vitest-environment happy-dom

import type * as PluginSyntaxPacks from '@/store/plugin-syntax-packs'
import type * as PluginIconThemes from '@/store/plugin-icon-themes'
import type * as PluginThemes from '@/store/plugin-themes'
import type * as PluginLanguagePacks from '@/store/plugin-language-packs'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { PluginsSettingsSection } from './PluginsSettingsSection'
import { PluginInstallTrustDialogHost } from '../dialogs/PluginInstallTrustDialog'

vi.mock('../state/plugin-theme-apply', () => ({
  applyPluginThemesNow: vi.fn().mockResolvedValue(false)
}))

// Why: cards read live theme stores, whose own change subscriptions aren't this section's.
vi.mock('../state/use-plugin-in-use', () => ({ usePluginInUse: () => null }))
vi.mock('../state/use-plugin-art-palettes', () => ({ usePluginArtPalettes: () => [] }))

// Unrelated content stores must not replace the fixture's single discovery callback.
vi.mock('@/store/plugin-language-packs', async (importOriginal) => ({
  ...(await importOriginal<typeof PluginLanguagePacks>()),
  ensurePluginLanguagePacksLoaded: () => {}
}))
vi.mock('@/store/plugin-syntax-packs', async (importOriginal) => ({
  ...(await importOriginal<typeof PluginSyntaxPacks>()),
  usePluginSyntaxes: () => []
}))
vi.mock('@/store/plugin-icon-themes', async (importOriginal) => ({
  ...(await importOriginal<typeof PluginIconThemes>()),
  usePluginIconThemes: () => []
}))
vi.mock('@/store/plugin-themes', async (importOriginal) => ({
  ...(await importOriginal<typeof PluginThemes>()),
  usePluginThemes: () => [],
  usePluginTerminalThemes: () => []
}))

vi.mock('../../settings/section-layout/SettingsSection', () => ({
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

vi.mock('../../ui/dropdown-menu', () => ({
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

vi.mock('../../ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))

vi.mock('../dialogs/PluginInstallDialog', () => ({
  PluginInstallDialog: ({
    open,
    onInstall
  }: {
    open: boolean
    onInstall: (source: { kind: 'git'; url: string; ref: string }) => Promise<void>
  }) =>
    open ? (
      <button
        onClick={() =>
          void onInstall({ kind: 'git', url: 'https://github.com/Acme/notes.git', ref: 'v1' })
        }
      >
        Submit Git install
      </button>
    ) : null
}))
// Why mock the consent: review now happens on the plugin's page, where this section sits.
vi.mock('../review/PluginInstallConsent', () => ({
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
vi.mock('../dialogs/PluginRemoveDialog', () => ({
  PluginRemoveDialog: ({
    plugin,
    onConfirm
  }: {
    plugin: PluginHostListEntry | null
    onConfirm: (key: string) => void
  }) =>
    plugin ? <button onClick={() => onConfirm(plugin.pluginKey)}>Confirm remove</button> : null
}))
vi.mock('../dialogs/PluginRollbackDialog', () => ({
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

/** Answers the open "Make sure you trust …" dialog, which must name this kind of warning; returns what it said. */
async function answerTrust(kind: string, label: string): Promise<string> {
  const dialog = document.querySelector<HTMLElement>('[data-plugin-install-trust]')
  if (!dialog) {
    throw new Error('missing install trust dialog')
  }
  expect(dialog.dataset.pluginInstallTrust).toBe(kind)
  const answer = Array.from(dialog.querySelectorAll('button')).find(
    (button) => button.textContent === label
  )
  if (!answer) {
    throw new Error(`missing ${label} in the trust dialog`)
  }
  const text = dialog.textContent ?? ''
  await act(async () => click(answer))
  return text
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
      <>
        <PluginsSettingsSection
          mounted={mounted}
          settings={settings}
          updateSettings={updateSettings}
        />
        <PluginInstallTrustDialogHost />
      </>
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

/** A card's enable switch. */
function toggleItem(container: HTMLElement, pluginKey: string): HTMLButtonElement {
  const item = container.querySelector<HTMLButtonElement>(
    `[data-plugin-key="${pluginKey}"] [role="switch"]`
  )
  if (!item) {
    throw new Error('missing plugin toggle')
  }
  return item
}

/** What the switch does next: "Enable" or "Disable". */
function toggleAction(item: HTMLButtonElement): string | undefined {
  return item.getAttribute('aria-label')?.split(' ')[0]
}

beforeEach(() => installApi())

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('PluginsSettingsSection lifecycle', () => {
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
    expect(toggleAction(toggleItem(container, plugin.pluginKey))).toBe('Enable')
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
    const notes = (): HTMLButtonElement => toggleItem(container, plugin.pluginKey)
    const tasks = (): HTMLButtonElement => toggleItem(container, secondPlugin.pluginKey)

    act(() => click(notes()))
    act(() => click(tasks()))
    expect(notes().disabled).toBe(true)
    expect(tasks().disabled).toBe(true)

    await act(async () => secondToggle.resolve([plugin, { ...secondPlugin, status: 'disabled' }]))

    expect(notes().disabled).toBe(true)
    expect(tasks().disabled).toBe(false)
    await act(async () =>
      firstToggle.resolve([
        { ...plugin, status: 'disabled' },
        { ...secondPlugin, status: 'disabled' }
      ])
    )
    expect(notes().disabled).toBe(false)
    expect(toggleAction(notes())).toBe('Enable')
    expect(toggleAction(tasks())).toBe('Enable')
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
    await answerTrust('dev-folder', 'Add folder')

    expect(input.value).toBe('/plugins/demo')
    expect(add.disabled).toBe(false)
    expect(window.api.plugins.refresh).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Could not save plugin settings.')
  })
})
