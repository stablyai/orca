// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { CodexSharedServerBanner } from './CodexSharedServerBanner'
import type { CodexSharedServerStatus } from '../../../../../../shared/codex-shared-server-command'
import {
  admitTerminalNoticeLifetime,
  getTerminalNoticeLifetime,
  retireTerminalNoticeLifetime
} from '../terminal-notice-lifetime'
import {
  installIpcPtyWindow,
  restorePtySpecWindow
} from '../../pty-transport/ipc/pty-transport-test-harness'

import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'

import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'

import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'

import { renderNoticePaneLifecycle } from './terminal-notice-pane.test-fixture'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'

import { retireUnboundIpcTerminalPane } from '../../layout/close/retire-unbound-ipc-terminal-pane'

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

let paneElement: HTMLDivElement
let root: Root
let isCodexOnSharedServer: ReturnType<
  typeof vi.fn<(id: string) => Promise<CodexSharedServerStatus>>
>
let disableCodexSharedServerAutoStart: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>
let stopCodexSharedServer: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>
let writeClipboardText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>
let updateSettings: ReturnType<typeof vi.fn<(updates: Partial<GlobalSettings>) => Promise<void>>>
let nextPtyId = 0
let ptyId: string

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
  admitTerminalNoticeLifetime(ptyId, { fresh: true })
  paneElement = document.createElement('div')
  paneElement.className = 'pane'
  document.body.appendChild(paneElement)
  root = createRoot(paneElement)
  isCodexOnSharedServer = vi.fn(() => Promise.resolve<CodexSharedServerStatus>(JOINED))
  disableCodexSharedServerAutoStart = vi.fn(() => Promise.resolve(true))
  stopCodexSharedServer = vi.fn(() => Promise.resolve(true))
  writeClipboardText = vi.fn(() => Promise.resolve())
  updateSettings = vi.fn((updates: Partial<GlobalSettings>) => {
    setState({ ...useAppStore.getState().settings, ...updates })
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
})
