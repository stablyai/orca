// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../../../../shared/constants'
import type { SettingsUpdate } from '@/store/slices/settings/create-settings-slice'
import { CodexSharedServerBanner } from './CodexSharedServerBanner'
import type { CodexSharedServerStatus } from '../../../../../../shared/codex-shared-server-command'
import {
  admitTerminalNoticeLifetime,
  getTerminalNoticeLifetime,
  retireTerminalNoticeLifetime
} from '../terminal-notice-lifetime'
import {
  installIpcPtyWindow,
  restorePtySpecWindow,
  type PtyExitPayload
} from '../../pty-transport/ipc/pty-transport-test-harness'
import { closeTerminalTab } from '../../../terminal/terminal-tab-actions'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { mergeFetchedWorktrees } from '@/store/slices/worktrees/listing/fetched-worktree-merge'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { retireParkedTerminalTab } from '../../parking/output-watchers/terminal-parked-watcher-registry'
import { applyClosedTerminalLeafNotice } from '../../layout/close/closed-terminal-leaf-notice'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'

import {
  renderNoticePaneLifecycle,
  deliverNoticePaneStartupExit
} from './terminal-notice-pane.test-fixture'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'

import { retireUnboundIpcTerminalPane } from '../../layout/close/retire-unbound-ipc-terminal-pane'

import { startParkedPtyWatcher } from '../../parking/output-watchers/terminal-parked-pty-watcher'
import type { ParkedTabWatcherEntry } from '../../parking/output-watchers/terminal-parked-watcher-registry'
import { settleDeferredPtyShutdownExits } from '../../pty-transport/shutdown/pty-shutdown-exit-deferral'

const routing = vi.hoisted(() => ({
  activateAndRevealWorkspace: vi.fn<(id: string) => unknown>(),
  revealFloatingWorkspacePanel: vi.fn(),
  createFloatingWorkspaceTerminalTab: vi.fn()
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: routing.activateAndRevealWorkspace
}))
vi.mock('@/components/floating-terminal/floating-workspace-panel-reveal', () => ({
  revealFloatingWorkspacePanel: routing.revealFloatingWorkspacePanel
}))
vi.mock('@/components/floating-terminal/floating-workspace-tab-creation', () => ({
  createFloatingWorkspaceTerminalTab: routing.createFloatingWorkspaceTerminalTab
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const JOINED: CodexSharedServerStatus = { joined: true, openedBeforeWrapper: false }
const NOT_JOINED: CodexSharedServerStatus = { joined: false }
const OLD_TAB_JOINED: CodexSharedServerStatus = { joined: true, openedBeforeWrapper: true }
const TITLE = 'This Codex is sharing a server'
let paneElement: HTMLDivElement
let root: Root
let isCodexOnSharedServer: ReturnType<
  typeof vi.fn<(id: string) => Promise<CodexSharedServerStatus>>
>
let disableCodexSharedServerAutoStart: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>
let stopCodexSharedServer: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>
let writeClipboardText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>
let updateSettings: ReturnType<typeof vi.fn<(updates: SettingsUpdate) => Promise<void>>>
let nextPtyId = 0
let ptyId: string
let admitted: ReturnType<typeof admitTerminalNoticeLifetime>

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

function setState(settings: Partial<GlobalSettings>, agent: 'codex' | null = 'codex'): void {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/me'), ...settings },
    paneForegroundAgentByPaneKey: agent ? { [PANE_KEY]: { agent, shellForeground: false } } : {},
    updateSettings
  })
}

function installPtyEvents(sinks: Parameters<typeof installIpcPtyWindow>[1]): void {
  const domWindow = window
  installIpcPtyWindow(domWindow, sinks)
  const api = window.api
  restorePtySpecWindow(domWindow)
  Object.defineProperty(domWindow, 'api', { configurable: true, value: api })
}

async function renderBanner(): Promise<void> {
  await act(async () => {
    root.render(<CodexSharedServerBanner ptyId={ptyId} tabId={TAB_ID} leafId={LEAF_ID} />)
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function renderPaneLifecycle(transport: PtyTransport, worktreeId = 'wt-1') {
  return renderNoticePaneLifecycle(root, ptyId, TAB_ID, LEAF_ID, transport, worktreeId)
}

// Why document: the dialog portals out of the pane.
function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button')).find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label
  )
  if (!match) {
    throw new Error(`missing ${label} button`)
  }
  return match
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  routing.activateAndRevealWorkspace.mockReturnValue({ primaryTabId: null })
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  useAppStore.setState(useAppStore.getInitialState(), true)
  ptyId = `wt-1@@pty-${(nextPtyId += 1)}`
  admitted = admitTerminalNoticeLifetime(ptyId, { fresh: true })
  paneElement = document.createElement('div')
  paneElement.className = 'pane'
  document.body.appendChild(paneElement)
  root = createRoot(paneElement)
  isCodexOnSharedServer = vi.fn(() => Promise.resolve<CodexSharedServerStatus>(JOINED))
  disableCodexSharedServerAutoStart = vi.fn(() => Promise.resolve(true))
  stopCodexSharedServer = vi.fn(() => Promise.resolve(true))
  writeClipboardText = vi.fn(() => Promise.resolve())
  updateSettings = vi.fn((update: SettingsUpdate) => {
    const current = useAppStore.getState().settings ?? getDefaultSettings('/home/me')
    const updates = typeof update === 'function' ? update(current) : update
    setState({ ...current, ...updates })
    return Promise.resolve()
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      pty: { isCodexOnSharedServer, disableCodexSharedServerAutoStart, stopCodexSharedServer },
      ui: { writeClipboardText, set: vi.fn(() => Promise.resolve()) }
    }
  })
})

afterEach(() => {
  const current = getTerminalNoticeLifetime(ptyId)
  if (current) {
    retireTerminalNoticeLifetime(current)
  }
  act(() => root.unmount())
  paneElement.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('CodexSharedServerBanner', () => {
  it('shows the warning after Codex joins the shared server', async () => {
    setState({})
    isCodexOnSharedServer.mockResolvedValueOnce(NOT_JOINED)
    await renderBanner()
    await advance(1_000)
    expect(paneElement.textContent).toBe('')
    await advance(4_000)
    expect(paneElement.textContent).toContain(TITLE)
  })

  it('confirms before stopping the server, then hides once it is gone', async () => {
    setState({})
    await renderBanner()
    await advance(1_000)
    await act(async () => button('Fix').click())
    await act(async () => button('Turn off').click())
    await act(async () => button('Stop server').click())
    expect(stopCodexSharedServer).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Stop the shared server?')

    await act(async () => button('Cancel').click())
    expect(stopCodexSharedServer).not.toHaveBeenCalled()

    await act(async () => button('Stop server').click())
    const confirm = Array.from(document.querySelectorAll('button')).filter(
      (candidate) => candidate.textContent?.trim() === 'Stop server'
    )
    isCodexOnSharedServer.mockResolvedValue(NOT_JOINED)
    await act(async () => confirm.at(-1)?.click())
    expect(stopCodexSharedServer).toHaveBeenCalledWith(ptyId)
    expect(document.body.textContent).toContain('Stopped')

    await act(async () => button('Done').click())
    await advance(20_000)
    expect(paneElement.textContent).toBe('')
  })

  it('keeps a live dismissal through detach and loss, then shows for a later attached lifetime', async () => {
    retireTerminalNoticeLifetime(admitted)
    let exit: ((payload: PtyExitPayload) => void) | undefined
    installPtyEvents({
      exit: (callback) => {
        exit = callback
      }
    })
    const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
    const { ensurePtyDispatcher, reattachPtyDispatcherPushListeners } =
      await import('../../pty-transport/delivery/pty-dispatcher')
    ensurePtyDispatcher()
    reattachPtyDispatcherPushListeners()
    setState({})
    let transport = createIpcPtyTransport({})
    const attach = () => {
      useAppStore.setState({
        tabsByWorktree: { 'wt-1': [makeTab({ id: TAB_ID, worktreeId: 'wt-1', ptyId: null })] }
      })
      useAppStore.getState().setPaneForegroundAgent(PANE_KEY, {
        agent: 'codex',
        shellForeground: false
      })
      transport.attach({
        existingPtyId: ptyId,
        callbacks: {
          onExit: (code) => {
            if (code >= 0) {
              closeTerminalTab(TAB_ID, { hostCloseReason: 'pty-exit', lifecyclePtyId: ptyId })
            }
          }
        }
      })
    }
    attach()
    await renderBanner()
    await advance(1_000)
    await act(async () => button('Dismiss').click())
    expect(paneElement.textContent).toBe('')
    transport.detach?.()
    // The move path removes a tab with pty-exit while its process survives.
    act(() => useAppStore.getState().closeTab(TAB_ID, { reason: 'pty-exit' }))
    act(() => root.unmount())
    root = createRoot(paneElement)
    transport = createIpcPtyTransport({})
    attach()
    await renderBanner()
    await advance(20_000)
    expect(paneElement.textContent).toBe('')
    await act(async () => exit?.({ id: ptyId, code: -1 }))
    transport = createIpcPtyTransport({})
    attach()
    await renderBanner()
    await advance(20_000)
    expect(paneElement.textContent).toBe('')
    await act(async () => exit?.({ id: ptyId, code: 0 }))
    transport = createIpcPtyTransport({})
    attach()
    await renderBanner()
    await advance(1_000)
    expect(paneElement.querySelector('button')).not.toBeNull()
    transport.detach?.()
  })

  it('keeps dismissal after an unstamped buffered exit, then accepts a stamped death', async () => {
    retireTerminalNoticeLifetime(admitted)
    let exit: ((payload: PtyExitPayload) => void) | undefined
    installPtyEvents({
      exit: (callback) => {
        exit = callback
      }
    })
    const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
    const { ensurePtyDispatcher, reattachPtyDispatcherPushListeners } =
      await import('../../pty-transport/delivery/pty-dispatcher')
    ensurePtyDispatcher()
    reattachPtyDispatcherPushListeners()
    const spawn = vi.mocked(window.api.pty.spawn)
    spawn.mockResolvedValueOnce({ id: ptyId, incarnationId: 'current-incarnation' })
    let transport = createIpcPtyTransport({})
    await transport.connect({ url: '', callbacks: {} })
    setState({})
    await renderBanner()
    await advance(1_000)
    await act(async () => button('Dismiss').click())
    transport.detach?.({ preserveExitObserver: false })
    spawn.mockImplementationOnce(async () => {
      exit?.({ id: ptyId, code: 0 })
      return { id: ptyId, incarnationId: 'current-incarnation', isReattach: true }
    })
    transport = createIpcPtyTransport({})
    await transport.connect({ url: '', callbacks: {} })
    transport = createIpcPtyTransport({})
    transport.attach({ existingPtyId: ptyId, callbacks: {} })
    await renderBanner()
    await advance(20_000)
    expect(paneElement.textContent).toBe('')
    await act(async () => exit?.({ id: ptyId, code: 0, incarnationId: 'current-incarnation' }))
    transport = createIpcPtyTransport({})
    transport.attach({ existingPtyId: ptyId, callbacks: {} })
    await renderBanner()
    await advance(1_000)
    expect(paneElement.querySelector('button')).not.toBeNull()
    transport.detach?.({ preserveExitObserver: false })
  })

  it('keeps dismissal on shutdown rollback and resets it on committed retirement', async () => {
    retireTerminalNoticeLifetime(admitted)
    let exit: ((payload: PtyExitPayload) => void) | undefined
    installPtyEvents({
      exit: (callback) => {
        exit = callback
      }
    })
    const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
    const { ensurePtyDispatcher, reattachPtyDispatcherPushListeners } =
      await import('../../pty-transport/delivery/pty-dispatcher')
    ensurePtyDispatcher()
    reattachPtyDispatcherPushListeners()
    const { settleDeferredPtyShutdownExits } =
      await import('../../pty-transport/shutdown/pty-shutdown-exit-deferral')
    vi.mocked(window.api.pty.spawn).mockResolvedValueOnce({
      id: ptyId,
      incarnationId: 'current-incarnation'
    })
    let transport = createIpcPtyTransport({})
    await transport.connect({ url: '', callbacks: {} })
    setState({})
    await renderBanner()
    await advance(1_000)
    await act(async () => button('Dismiss').click())
    useAppStore.setState({ pendingPtyShutdownIds: { [ptyId]: 1 } })
    await act(async () => exit?.({ id: ptyId, code: 0, incarnationId: 'current-incarnation' }))
    settleDeferredPtyShutdownExits([ptyId], 'rolled-back')
    useAppStore.setState({ pendingPtyShutdownIds: {} })
    transport = createIpcPtyTransport({})
    transport.attach({ existingPtyId: ptyId, callbacks: {} })
    await renderBanner()
    await advance(20_000)
    expect(paneElement.textContent).toBe('')
    useAppStore.setState({ pendingPtyShutdownIds: { [ptyId]: 1 } })
    await act(async () => exit?.({ id: ptyId, code: 0, incarnationId: 'current-incarnation' }))
    settleDeferredPtyShutdownExits([ptyId], 'committed')
    useAppStore.setState({ pendingPtyShutdownIds: {} })
    transport = createIpcPtyTransport({})
    transport.attach({ existingPtyId: ptyId, callbacks: {} })
    await renderBanner()
    await advance(1_000)
    expect(paneElement.querySelector('button')).not.toBeNull()
    transport.detach?.()
  })

  async function expectWarningAfterRetirement(
    retire: (worktreeId: string, transport: PtyTransport) => void | Promise<unknown>
  ) {
    installPtyEvents({})
    const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
    let transport = createIpcPtyTransport({})
    const worktreeId = 'repo::/notice-retirement'
    const publish = () => {
      useAppStore.setState({
        repos: [{ ...TEST_REPO, id: 'repo', executionHostId: 'local' }],
        worktreesByRepo: {
          repo: [makeWorktree({ id: worktreeId, repoId: 'repo', hostId: 'local' })]
        },
        tabsByWorktree: { [worktreeId]: [makeTab({ id: TAB_ID, worktreeId, ptyId })] },
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: { type: 'leaf', leafId: LEAF_ID },
            activeLeafId: LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF_ID]: ptyId }
          }
        }
      })
      useAppStore
        .getState()
        .setPaneForegroundAgent(PANE_KEY, { agent: 'codex', shellForeground: false })
      transport.attach({ existingPtyId: ptyId, callbacks: {} })
    }
    setState({})
    publish()
    await renderBanner()
    await advance(1_000)
    await act(async () => button('Dismiss').click())
    transport.detach?.({ preserveExitObserver: false })
    await retire(worktreeId, transport)
    transport = createIpcPtyTransport({})
    publish()
    await renderBanner()
    await advance(1_000)
    expect(paneElement.querySelector('button')).not.toBeNull()
    transport.detach?.({ preserveExitObserver: false })
    retireParkedTerminalTab(TAB_ID)
  }

  it('shows the warning for a reused terminal after explicit purge', async () => {
    await expectWarningAfterRetirement((worktreeId) => {
      useAppStore.getState().purgeWorktreeTerminalState([worktreeId])
    })
  })

  it('shows the warning for a reused terminal after authoritative listing', async () => {
    await expectWarningAfterRetirement(() => {
      mergeFetchedWorktrees(useAppStore.setState, useAppStore.getState, {
        repoId: 'repo',
        hostId: 'local',
        ownerWasMissingAtStart: false,
        requestStartedWorktrees: useAppStore.getState().worktreesByRepo.repo,
        refresh: {
          status: 'admitted',
          executionHostId: 'local',
          result: { repoId: 'repo', authoritative: true, source: 'git', worktrees: [] }
        }
      })
    })
  })

  it('shows the warning for a reused terminal after parked main close', async () => {
    await expectWarningAfterRetirement(async (worktreeId, transport) => {
      const pane = await renderPaneLifecycle(transport, worktreeId)
      await act(async () => {
        pane.park()
        useAppStore.setState({ terminalLayoutsByTabId: {} })
        applyClosedTerminalLeafNotice(TAB_ID, LEAF_ID, 'user')
      })
    })
  })

  function publishPaneOwner() {
    useAppStore.setState({
      repos: [{ ...TEST_REPO, id: 'repo', executionHostId: 'local' }],
      worktreesByRepo: { repo: [makeWorktree({ id: 'wt-1', repoId: 'repo', hostId: 'local' })] },
      tabsByWorktree: { 'wt-1': [makeTab({ id: TAB_ID, worktreeId: 'wt-1', ptyId })] },
      terminalLayoutsByTabId: {
        [TAB_ID]: {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: ptyId }
        }
      }
    })
  }

  async function dismissPaneWarning() {
    installPtyEvents({})
    const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
    publishPaneOwner()
    setState({})
    const transport = createIpcPtyTransport({})
    transport.attach({ existingPtyId: ptyId, callbacks: {} })
    const pane = await renderPaneLifecycle(transport)
    await advance(1_000)
    await act(async () => button('Dismiss').click())
    return { ...pane, transport }
  }

  async function reattachPaneWarning() {
    const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
    const next = createIpcPtyTransport({})
    next.attach({ existingPtyId: ptyId, callbacks: {} })
    setState({})
    await renderBanner()
    await advance(1_000)
    next.detach?.({ preserveExitObserver: false })
  }

  it('releases a closed bound pane dismissal when its own transport was its last owner', async () => {
    const pane = await dismissPaneWarning()
    await act(async () => pane.close())
    await reattachPaneWarning()
    expect(paneElement.querySelector('button')).not.toBeNull()
  })

  it('keeps a dismissal when a replacement transport still owns the same PTY', async () => {
    const pane = await dismissPaneWarning()
    const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
    const replacement = createIpcPtyTransport({})
    replacement.attach({ existingPtyId: ptyId, callbacks: {} })
    pane.transports.set(2, replacement)
    await act(async () => pane.close())
    replacement.detach?.({ preserveExitObserver: false })
    await reattachPaneWarning()
    expect(paneElement.textContent).toBe('')
  })

  it('releases an old-host exit dismissal while keeping the startup failure readable', async () => {
    const pane = await dismissPaneWarning()
    await deliverNoticePaneStartupExit(pane.transport, pane.transports, ptyId, TAB_ID, PANE_KEY)
    expect(useAppStore.getState().tabsByWorktree['wt-1'].map((tab) => tab.id)).toEqual([TAB_ID])
    pane.transport.detach?.({ preserveExitObserver: false })
    await reattachPaneWarning()
    expect(paneElement.querySelector('button')).not.toBeNull()
  })

  it('releases a pending unbound close without letting its late reply retire a successor', async () => {
    const pane = await dismissPaneWarning()
    pane.transport.detach?.({ preserveExitObserver: false })
    const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
    const spawn = Promise.withResolvers<{ id: string }>()
    vi.mocked(window.api.pty.spawn).mockReturnValueOnce(spawn.promise)
    const pending = createIpcPtyTransport({})
    const connecting = pending.connect({ url: '', sessionId: ptyId, callbacks: {} })
    await act(async () =>
      retireUnboundIpcTerminalPane({
        getState: useAppStore.getState,
        tabId: TAB_ID,
        leafId: LEAF_ID,
        transport: pending,
        getTransports: () => new Map([[1, pending]])
      })
    )
    await reattachPaneWarning()
    expect(paneElement.querySelector('button')).not.toBeNull()
    await act(async () => button('Dismiss').click())
    await act(async () => {
      spawn.resolve({ id: ptyId })
      await connecting
    })
    await reattachPaneWarning()
    expect(paneElement.textContent).toBe('')
  })

  async function parkedExitFixture() {
    const pane = await dismissPaneWarning()
    pane.park()
    let exit: ((payload: PtyExitPayload) => void) | undefined
    installPtyEvents({
      exit: (callback) => {
        exit = callback
      }
    })
    const { ensurePtyDispatcher, reattachPtyDispatcherPushListeners } =
      await import('../../pty-transport/delivery/pty-dispatcher')
    ensurePtyDispatcher()
    reattachPtyDispatcherPushListeners()
    const entry: ParkedTabWatcherEntry = {
      worktreeId: 'wt-1',
      tabPtyId: ptyId,
      paneIdByPtyId: new Map(),
      disposersByPtyId: new Map()
    }
    startParkedPtyWatcher({
      worktreeId: 'wt-1',
      tab: { id: TAB_ID, ptyId },
      entry,
      pane: { ptyId, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true, untouchedFreshSpawn: true },
      restoreTitleOnRegister: false,
      restorePolicy: {}
    })
    return {
      exit: () => exit?.({ id: ptyId, code: 1 }),
      dispose: () => entry.disposersByPtyId.get(ptyId)?.()
    }
  }

  it('releases a parked old-host startup failure dismissal without removing its diagnostic tab', async () => {
    const parked = await parkedExitFixture()
    await act(async () => parked.exit())
    expect(useAppStore.getState().tabsByWorktree['wt-1'].map((tab) => tab.id)).toEqual([TAB_ID])
    parked.dispose()
    await reattachPaneWarning()
    expect(paneElement.querySelector('button')).not.toBeNull()
    retireParkedTerminalTab(TAB_ID)
  })

  it('keeps a parked dismissal when a pending shutdown rolls back', async () => {
    const parked = await parkedExitFixture()
    useAppStore.setState({ pendingPtyShutdownIds: { [ptyId]: 1 } })
    await act(async () => parked.exit())
    useAppStore.setState({ pendingPtyShutdownIds: {} })
    await act(async () => settleDeferredPtyShutdownExits([ptyId], 'rolled-back'))
    parked.dispose()
    await reattachPaneWarning()
    expect(paneElement.textContent).toBe('')
    retireParkedTerminalTab(TAB_ID)
  })

  it('releases a dismissal only after workspace removal succeeds', async () => {
    await expectWarningAfterRetirement(async (worktreeId) => {
      Object.assign(window.api, { worktrees: { forgetLocal: vi.fn().mockResolvedValue({}) } })
      const result = await useAppStore
        .getState()
        .removeWorktree({ id: worktreeId, executionHostId: 'local' }, false, {
          mode: 'forget-local'
        })
      expect(result.ok).toBe(true)
    })
  })

  it('keeps the dismissal when workspace removal fails at dispatch', async () => {
    const pane = await dismissPaneWarning()
    const forgetLocal = vi.fn().mockRejectedValue(new Error('disk unavailable'))
    Object.assign(window.api, { worktrees: { forgetLocal } })
    const result = await useAppStore
      .getState()
      .removeWorktree({ id: 'wt-1', executionHostId: 'local' }, false, { mode: 'forget-local' })
    expect(result).toEqual({ ok: false, error: 'disk unavailable' })
    pane.transport.detach?.({ preserveExitObserver: false })
    await reattachPaneWarning()
    expect(paneElement.textContent).toBe('')
  })

  it('preserves a shared dismissal when a workspace is purged', async () => {
    installPtyEvents({})
    const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
    let transport = createIpcPtyTransport({})
    setState({})
    useAppStore.setState({
      tabsByWorktree: {
        gone: [makeTab({ id: TAB_ID, worktreeId: 'gone', ptyId })],
        kept: [makeTab({ id: 'shared-owner', worktreeId: 'kept', ptyId })]
      }
    })
    transport.attach({ existingPtyId: ptyId, callbacks: {} })
    await renderBanner()
    await advance(1_000)
    await act(async () => button('Dismiss').click())
    transport.detach?.({ preserveExitObserver: false })
    await act(async () => useAppStore.getState().purgeWorktreeTerminalState(['gone']))
    transport = createIpcPtyTransport({})
    transport.attach({ existingPtyId: ptyId, callbacks: {} })
    setState({})
    await renderBanner()
    await advance(20_000)
    expect(paneElement.textContent).toBe('')
    transport.detach?.({ preserveExitObserver: false })
  })

  it('retires the freshly admitted same-ID parked owner after an older capture', async () => {
    installPtyEvents({})
    const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: TAB_ID, worktreeId: 'wt-1', ptyId })] }
    })
    const old = createIpcPtyTransport({})
    old.attach({ existingPtyId: ptyId, callbacks: {} })
    const oldPane = await renderPaneLifecycle(old)
    oldPane.park()
    const transport = createIpcPtyTransport({})
    vi.mocked(window.api.pty.spawn).mockResolvedValueOnce({ id: ptyId })
    await transport.connect({ url: '', callbacks: {} })
    setState({})
    await renderBanner()
    await advance(1_000)
    await act(async () => button('Dismiss').click())
    const freshPane = await renderPaneLifecycle(transport)
    freshPane.park()
    useAppStore.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: TAB_ID, worktreeId: 'wt-1', ptyId: 'surviving-sibling' })]
      },
      terminalLayoutsByTabId: {}
    })
    await act(async () => applyClosedTerminalLeafNotice(TAB_ID, LEAF_ID, 'user'))
    const next = createIpcPtyTransport({})
    next.attach({ existingPtyId: ptyId, callbacks: {} })
    setState({})
    await renderBanner()
    await advance(1_000)
    expect(paneElement.querySelector('button')).not.toBeNull()
    next.detach?.({ preserveExitObserver: false })
    retireParkedTerminalTab(TAB_ID)
  })

  describe('returning focus when a dialog closes', () => {
    // Why a real xterm textarea: the dialogs have no trigger, so only the hook can restore focus.
    function mountActiveTerminal(): HTMLTextAreaElement {
      useAppStore.setState({
        activeWorktreeId: 'wt-1',
        activeTabType: 'terminal',
        activeTabIdByWorktree: { 'wt-1': TAB_ID },
        terminalLayoutsByTabId: {
          [TAB_ID]: { root: null, activeLeafId: LEAF_ID, expandedLeafId: null }
        }
      })
      const tab = document.createElement('div')
      tab.dataset.terminalTabId = TAB_ID
      const leaf = document.createElement('div')
      leaf.dataset.leafId = LEAF_ID
      const xterm = document.createElement('textarea')
      xterm.className = 'xterm-helper-textarea'
      leaf.append(xterm)
      tab.append(leaf)
      document.body.append(tab)
      xterm.focus()
      return xterm
    }

    async function pressEscape(): Promise<void> {
      await act(async () => {
        ;(document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        )
      })
      await advance(100)
    }

    afterEach(() => {
      document.querySelector('[data-terminal-tab-id]')?.remove()
    })

    it.each([
      ['Fix', JOINED, 'Fix'],
      ['old-terminal Learn more', OLD_TAB_JOINED, 'Learn more']
    ])(
      'returns focus to the terminal after Esc closes the %s dialog',
      async (_l, status, label) => {
        setState({})
        isCodexOnSharedServer.mockResolvedValue(status)
        const xterm = mountActiveTerminal()
        await renderBanner()
        await advance(1_000)
        await act(async () => button(label).click())
        expect(document.querySelector('[role="dialog"]')).not.toBeNull()
        expect(document.activeElement).not.toBe(xterm)

        await pressEscape()

        expect(document.querySelector('[role="dialog"]')).toBeNull()
        expect(document.activeElement).toBe(xterm)
      }
    )

    it('leaves focus in the new terminal after Open new terminal', async () => {
      setState({})
      const xterm = mountActiveTerminal()
      const newTerminal = document.createElement('textarea')
      document.body.append(newTerminal)
      useAppStore.setState({
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'unified-1',
              entityId: TAB_ID,
              groupId: 'group-1',
              worktreeId: 'wt-1',
              contentType: 'terminal',
              label: 'Terminal',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 0
            }
          ]
        },
        openNewTerminalTabInActiveWorkspace: vi.fn(() => {
          newTerminal.focus()
          return Promise.resolve()
        })
      })
      isCodexOnSharedServer.mockResolvedValue(OLD_TAB_JOINED)
      await renderBanner()
      await advance(1_000)
      await act(async () => button('Learn more').click())
      await clickDialogOpenNewTerminal()

      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(document.activeElement).toBe(newTerminal)
      expect(document.activeElement).not.toBe(xterm)
      newTerminal.remove()
    })

    async function clickDialogOpenNewTerminal(): Promise<void> {
      const inDialog = Array.from(
        document.querySelector('[role="dialog"]')?.querySelectorAll('button') ?? []
      ).find((candidate) => candidate.textContent?.trim() === 'Open new terminal')
      await act(async () => inDialog?.click())
      await advance(100)
    }

    it('returns focus to this terminal when Open new terminal cannot open one', async () => {
      setState({})
      useAppStore.setState({ unifiedTabsByWorktree: {} })
      const xterm = mountActiveTerminal()
      isCodexOnSharedServer.mockResolvedValue(OLD_TAB_JOINED)
      await renderBanner()
      await advance(1_000)
      await act(async () => button('Learn more').click())

      await clickDialogOpenNewTerminal()

      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(document.activeElement).toBe(xterm)
    })

    it('keeps the Learn more dialog open when this Codex ends, then returns focus', async () => {
      setState({})
      const xterm = mountActiveTerminal()
      isCodexOnSharedServer.mockResolvedValue(OLD_TAB_JOINED)
      await renderBanner()
      await advance(1_000)
      await act(async () => button('Learn more').click())

      setState({}, null)
      await advance(100)
      expect(document.querySelector('[role="dialog"]')).not.toBeNull()
      expect(paneElement.textContent).toBe('')

      await pressEscape()

      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(document.activeElement).toBe(xterm)
    })

    it('returns focus to the pane terminal after Stop server ends its Codex', async () => {
      setState({})
      const xterm = mountActiveTerminal()
      await renderBanner()
      await advance(1_000)
      await act(async () => button('Fix').click())
      await act(async () => button('Turn off').click())
      await act(async () => button('Stop server').click())
      isCodexOnSharedServer.mockResolvedValue(NOT_JOINED)
      const confirm = Array.from(document.querySelectorAll('button')).filter(
        (candidate) => candidate.textContent?.trim() === 'Stop server'
      )
      await act(async () => confirm.at(-1)?.click())
      await advance(20_000)
      expect(stopCodexSharedServer).toHaveBeenCalledWith(ptyId)
      expect(document.body.textContent).toContain('Stopped')

      await pressEscape()

      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(paneElement.textContent).toBe('')
      expect(document.activeElement).toBe(xterm)
    })
  })
})
