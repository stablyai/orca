// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { PreparedDroppedPaths } from '../../../../shared/native-file-drop-preparation'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { ManagedPaneInternal } from '@/lib/pane-manager/pane-manager-types'
import { collectPublicPanes, toPublicPane } from '@/lib/pane-manager/pane-public-view'
import type { PtyTransport } from './pty-transport'
import type { TerminalPaneController } from './use-terminal-pane-controller'
import {
  NativeChatPaneFileDropSurface,
  useNativeChatPaneFileDropClaim
} from '@/components/native-chat/NativeChatPaneFileDropSurface'
import { TerminalPaneSurface } from './TerminalPaneSurface'
import { installOsFileDropCancellationGuard } from '@/lib/os-file-drop-cancellation-guard'

const mocks = vi.hoisted(() => ({
  state: {
    settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
    projects: [],
    repos: [],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Every fixture record has the declared catalog shape.
    worktreesByRepo: {} as Record<
      string,
      { id: string; repoId: string; path: string; hostId: string }[]
    >,
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    sshConnectionStates: new Map([['target', { connectionGeneration: 4, remotePlatform: 'linux' }]])
  },
  prepare: vi.fn(),
  importPaths: vi.fn(),
  resolvePaths: vi.fn(),
  chatDrop: vi.fn(),
  toastError: vi.fn(),
  legacyIpc: vi.fn(),
  editorOpen: vi.fn(),
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The portal target starts absent and is assigned only a fixture pane container.
  chatPane: null as HTMLElement | null,
  chatDisabled: false
}))
vi.mock('electron', () => ({
  ipcRenderer: { on: vi.fn(), send: mocks.legacyIpc, removeListener: vi.fn() },
  webUtils: { getPathForFile: (file: File) => `/client/${file.name}` }
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    <T,>(selector: (state: typeof mocks.state) => T) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))
vi.mock('@/runtime/runtime-file-client', () => ({
  importExternalPathsToRuntime: mocks.importPaths
}))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'win32' }))
vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, loading: vi.fn(), dismiss: vi.fn(), message: vi.fn() }
}))
vi.mock('./terminal-input-activity', () => ({ recordTerminalUserInputForLeaf: vi.fn() }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null
}))
vi.mock('@/components/TerminalSearch', () => ({ default: () => null }))
vi.mock('@/components/shared/useDaemonActions', () => ({ DaemonActionDialog: () => null }))
vi.mock('@/components/agent-session-continuation/AgentSessionContinuationDialog', () => ({
  AgentSessionContinuationDialog: () => null
}))
vi.mock('./CloseTerminalDialog', () => ({ default: () => null }))
vi.mock('./TerminalContextMenu', () => ({ default: () => null }))
vi.mock('./TerminalErrorToast', () => ({
  isPaneOwnerUnverifiedError: () => false,
  TerminalErrorToast: () => null
}))
vi.mock('./terminal-pane-recovery', () => ({ requestTerminalPaneRecovery: vi.fn() }))
vi.mock('./TerminalSessionStateSaveFailureDialog', () => ({
  TerminalSessionStateSaveFailureDialog: () => null
}))
vi.mock('@/components/link-actions/LinkActionPopover', () => ({ LinkActionPopover: () => null }))
vi.mock('./TerminalAgentSessionForkDialog', () => ({ TerminalAgentSessionForkDialog: () => null }))
vi.mock('./SessionRestoredBannerPortals', () => ({ SessionRestoredBannerPortals: () => null }))
vi.mock('./TerminalQuickCommandEditorDialog', () => ({
  TerminalQuickCommandEditorDialog: () => null
}))
vi.mock('./TerminalPaneRuntimePortals', () => ({
  TerminalPaneCodexRestartPortals: () => null,
  TerminalPaneMobileDriverPortals: () => null,
  TerminalPaneProcessExitPortals: () => null,
  TerminalPaneRecoveryPortals: () => null,
  TerminalPaneSshReconnectPortals: () => null
}))

function ChatClaim(): null {
  useNativeChatPaneFileDropClaim({
    disabled: mocks.chatDisabled,
    destinationKey: 'chat-A',
    captureExternalDrop: () => mocks.chatDrop,
    onDragOverCapture: vi.fn(),
    onDropCapture: vi.fn()
  })
  return null
}
vi.mock('./TerminalPaneNativeChatPortal', () => ({
  TerminalPaneNativeChatPortal: () =>
    mocks.chatPane &&
    createPortal(
      <NativeChatPaneFileDropSurface className="chat-drop">
        <ChatClaim />
        <span data-testid="chat-target" />
      </NativeChatPaneFileDropSurface>,
      mocks.chatPane
    )
}))

function makePane(id: number): ManagedPaneInternal {
  const leafId = `00000000-0000-4000-8000-00000000000${id}`
  if (!isTerminalLeafId(leafId)) {
    throw new Error('Invalid fixture leaf')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The surface reads identity, DOM container, and terminal focus; add-ons are mocked out.
  return {
    id,
    leafId,
    stablePaneId: leafId,
    container: document.createElement('div'),
    terminal: { focus: vi.fn() }
  } as unknown as ManagedPaneInternal
}

function mountSurface(
  options: {
    chat?: boolean
    hidden?: 'display' | 'inert'
    host?: string
    runtime?: string
    cwd?: string
    worktreeId?: string
  } = {}
) {
  const internalPanes = [makePane(1), makePane(2)]
  const paneRecords = new Map(internalPanes.map((pane) => [pane.id, pane]))
  const getPanes = () => collectPublicPanes(paneRecords, paneRecords.size)
  const panes = getPanes()
  const sends = panes.map(() => vi.fn(() => true))
  const ptyIds = ['pty-A', 'pty-B']
  const transports = new Map<number, PtyTransport>()
  panes.forEach((pane, index) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every transport method used by file drop capture and writes.
    transports.set(pane.id, {
      sendInput: sends[index],
      getPtyId: () => ptyIds[index],
      isConnected: () => true,
      getExecutionHostId: () => options.host ?? 'local',
      getRuntimeEnvironmentId: () => options.runtime ?? null
    } as unknown as PtyTransport)
  })
  const active = internalPanes[1]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The surface and drop handlers only enumerate panes and read active identity.
  const manager = { getPanes, getActivePane: () => toPublicPane(active) } as unknown as PaneManager
  const divider = document.createElement('div')
  const activate = vi.fn()
  mocks.chatPane = options.chat ? panes[0].container : null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: All live surface fields are supplied; unrelated dialogs and controller operations are mocked out.
  const controller = {
    activePane: active,
    managedPanes: panes,
    managerRef: { current: manager },
    paneTransportsRef: { current: transports },
    tabId: 'tab-1',
    worktreeId: options.worktreeId ?? 'wt-1',
    cwd: options.cwd,
    isActive: true,
    terminalContentVisible: true,
    hiddenStartupStyle: {},
    terminalContainerStyle: {},
    paneCount: 2,
    paneTitles: { 1: 'A', 2: 'B' },
    paneTitleOverlayRects: {
      1: { left: 0, top: 0, width: 200 },
      2: { left: 220, top: 0, width: 200 }
    },
    renamingPaneId: null,
    renameInputRef: { current: null },
    paneTitleBackground: 'transparent',
    activatePaneTitleInteraction: activate,
    contextMenu: {},
    daemonActions: {},
    sessionRestoredBannerPaneIds: [],
    setContainerRef: (root: HTMLElement | null) =>
      root?.append(panes[0].container, divider, panes[1].container)
  } as unknown as TerminalPaneController
  const view = render(
    <div
      style={options.hidden === 'display' ? { display: 'none' } : undefined}
      inert={options.hidden === 'inert' || undefined}
    >
      <TerminalPaneSurface controller={controller} />
    </div>
  )
  const titles = view.container.querySelectorAll('.pane-title-bar')
  return {
    view,
    panes,
    sends,
    manager,
    activate,
    transports,
    ptyIds,
    divider,
    title: titles[0],
    body: panes[0].container,
    replacePaneContainer: () => {
      paneRecords.set(panes[0].id, {
        ...internalPanes[0],
        container: document.createElement('div')
      })
    }
  }
}

function drop(target: Element, name = 'file.txt') {
  const event = new Event('drop', { bubbles: true, cancelable: true, composed: true })
  Object.defineProperty(event, 'isTrusted', { value: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files: [new File([], name)], dropEffect: 'move' }
  })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}
async function settle(): Promise<void> {
  await act(async () => undefined)
}

let disposeGuard: (() => void) | undefined
beforeEach(() => {
  vi.clearAllMocks()
  disposeGuard = installOsFileDropCancellationGuard()
  mocks.legacyIpc.mockImplementation((_channel: string, payload: { target: string }) => {
    if (payload.target === 'editor') {
      mocks.editorOpen()
    }
  })
  mocks.chatPane = null
  mocks.chatDisabled = false
  mocks.state.worktreesByRepo = {
    repo: [{ id: 'wt-1', repoId: 'repo', path: '/owner/workspace', hostId: 'local' }]
  }
  mocks.prepare.mockImplementation(async ({ paths }: { paths: string[] }) => ({
    paths,
    failures: []
  }))
  mocks.resolvePaths.mockResolvedValue({
    resolvedPaths: ['/host/file.txt'],
    skipped: [],
    failed: []
  })
  mocks.importPaths.mockResolvedValue({
    results: [{ status: 'imported', destPath: '/owner/workspace/.orca/drops/file.txt' }]
  })
  vi.stubGlobal('api', {
    fs: {
      getPathForFile: (file: File) => `/client/${file.name}`,
      prepareDroppedPaths: mocks.prepare,
      resolveDroppedPathsForAgent: mocks.resolvePaths
    }
  })
})
afterEach(() => {
  disposeGuard?.()
  cleanup()
  vi.unstubAllGlobals()
})

describe('terminal element file drops', () => {
  it('enumerates fresh public views of the same pane identities', () => {
    const fixture = mountSurface()
    const first = fixture.manager.getPanes()
    const second = fixture.manager.getPanes()
    for (const [index, pane] of first.entries()) {
      expect(pane).not.toBe(fixture.panes[index])
      expect(pane).not.toBe(second[index])
      expect(second[index]).toEqual(pane)
      expect(pane.container).toBe(fixture.panes[index].container)
    }
  })
  it.each(['title', 'body'] as const)(
    'delivers to A from its %s while B stays active and never broadcasts',
    async (root) => {
      const fixture = mountSurface()
      drop(fixture[root])
      await settle()
      expect(fixture.sends[0]).toHaveBeenCalledExactlyOnceWith('/client/file.txt ', 'driving')
      expect(fixture.sends[1]).not.toHaveBeenCalled()
      expect(fixture.panes[0].terminal.focus).not.toHaveBeenCalled()
      expect(fixture.activate).not.toHaveBeenCalled()
      expect(fixture.manager.getActivePane()).toEqual(fixture.panes[1])
      expect(mocks.legacyIpc).not.toHaveBeenCalled()
      expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith({
        paths: ['/client/file.txt'],
        consumer: 'agent'
      })
    }
  )
  it.each(['title', 'body'] as const)(
    'refuses a retired %s owner with the same pane and leaf IDs but a replaced container',
    async (root) => {
      const fixture = mountSurface()
      fixture.replacePaneContainer()
      expect(fixture[root].isConnected).toBe(true)
      expect(fixture.manager.getPanes()[0]).toMatchObject({
        id: fixture.panes[0].id,
        leafId: fixture.panes[0].leafId
      })
      expect(fixture.manager.getPanes()[0].container).not.toBe(fixture.body)
      drop(fixture[root])
      await settle()
      expect(mocks.prepare).not.toHaveBeenCalled()
      expect(fixture.sends[0]).not.toHaveBeenCalled()
      expect(fixture.sends[1]).not.toHaveBeenCalled()
    }
  )
  it.each(['title', 'body'] as const)(
    'refuses delivery from %s when its container is replaced during preparation',
    async (root) => {
      let finish: ((prepared: PreparedDroppedPaths) => void) | undefined
      mocks.prepare.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      const fixture = mountSurface()
      drop(fixture[root])
      expect(mocks.prepare).toHaveBeenCalledOnce()
      fixture.replacePaneContainer()
      await act(async () => {
        finish?.({ paths: ['/client/file.txt'], failures: [] })
      })
      expect(fixture.sends[0]).not.toHaveBeenCalled()
      expect(fixture.sends[1]).not.toHaveBeenCalled()
    }
  )
  it('leaves divider drops unowned', async () => {
    const fixture = mountSurface()
    expect(fixture.body.hasAttribute('data-os-file-drop-owner')).toBe(true)
    expect(fixture.body.parentElement?.hasAttribute('data-os-file-drop-owner')).toBe(false)
    const hover = new Event('dragover', { bubbles: true, cancelable: true, composed: true })
    const transfer = { types: ['Files'], dropEffect: 'move' }
    Object.defineProperty(hover, 'dataTransfer', { value: transfer })
    fixture.divider.dispatchEvent(hover)
    expect(transfer.dropEffect).toBe('none')
    const dropped = drop(fixture.divider)
    expect(dropped.defaultPrevented).toBe(true)
    expect(dropped).toHaveProperty('dataTransfer.dropEffect', 'none')
    await settle()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.legacyIpc).not.toHaveBeenCalled()
    expect(mocks.editorOpen).not.toHaveBeenCalled()
    expect(mocks.importPaths).not.toHaveBeenCalled()
    expect(mocks.resolvePaths).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(fixture.sends[0]).not.toHaveBeenCalled()
    expect(fixture.sends[1]).not.toHaveBeenCalled()
  })
  it('refuses unowned chrome without opening, uploading, or showing a toast', async () => {
    const fixture = mountSurface()
    const dropped = drop(fixture.view.container)
    await settle()
    expect(dropped.defaultPrevented).toBe(true)
    expect(dropped).toHaveProperty('dataTransfer.dropEffect', 'none')
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.legacyIpc).not.toHaveBeenCalled()
    expect(mocks.editorOpen).not.toHaveBeenCalled()
    expect(mocks.importPaths).not.toHaveBeenCalled()
    expect(mocks.resolvePaths).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(fixture.sends[0]).not.toHaveBeenCalled()
    expect(fixture.sends[1]).not.toHaveBeenCalled()
  })
  it('shares ordering across title and body during delayed preparation', async () => {
    let finish: ((prepared: PreparedDroppedPaths) => void) | undefined
    mocks.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const fixture = mountSurface()
    drop(fixture.title, 'first.txt')
    drop(fixture.body, 'second.txt')
    await settle()
    expect(fixture.sends[0]).not.toHaveBeenCalled()
    await act(async () => {
      finish?.({ paths: ['/prepared/first.txt'], failures: [] })
    })
    expect(fixture.sends[0].mock.calls).toEqual([
      ['/prepared/first.txt ', 'driving'],
      ['/client/second.txt ', 'driving']
    ])
  })
  it.each([false, true])(
    'keeps nested chat drops out of terminal (disabled=%s)',
    async (disabled) => {
      mocks.chatDisabled = disabled
      const fixture = mountSurface({ chat: true })
      drop(fixture.view.getByTestId('chat-target'))
      await settle()
      expect(mocks.chatDrop).toHaveBeenCalledTimes(disabled ? 0 : 1)
      expect(fixture.sends[0]).not.toHaveBeenCalled()
      drop(fixture.body)
      await settle()
      expect(fixture.sends[0]).toHaveBeenCalledExactlyOnceWith('/client/file.txt ', 'driving')
      expect(mocks.chatDrop).toHaveBeenCalledTimes(disabled ? 0 : 1)
    }
  )
  it.each(['display', 'inert'] as const)('refuses hidden terminal owners (%s)', async (hidden) => {
    const fixture = mountSurface({ hidden })
    expect(fixture.body.hasAttribute('data-os-file-drop-owner')).toBe(true)
    drop(fixture.title)
    drop(fixture.body)
    await settle()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(fixture.sends[0]).not.toHaveBeenCalled()
  })
  it('captures the PTY before preparation and refuses a replacement', async () => {
    let finish: ((prepared: PreparedDroppedPaths) => void) | undefined
    mocks.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const fixture = mountSurface()
    drop(fixture.title)
    fixture.ptyIds[0] = 'replacement'
    await act(async () => {
      finish?.({ paths: ['/client/file.txt'], failures: [] })
    })
    expect(fixture.sends[0]).not.toHaveBeenCalled()
    drop(fixture.body)
    await settle()
    expect(fixture.sends[0]).toHaveBeenCalledOnce()
  })
  it('uploads through the captured runtime catalog with physical local transport', async () => {
    mocks.state.worktreesByRepo = {
      local: [{ id: 'wt-1', repoId: 'local', path: 'C:\\wrong', hostId: 'local' }],
      remote: [
        { id: 'wt-1', repoId: 'remote', path: '/owner/workspace', hostId: 'runtime:owner-runtime' }
      ]
    }
    const fixture = mountSurface({ runtime: 'owner-runtime', cwd: '/wrong' })
    drop(fixture.title)
    await settle()
    expect(mocks.importPaths).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: { activeRuntimeEnvironmentId: 'owner-runtime' },
        worktreePath: '/owner/workspace',
        expectedExecutionHostId: 'local'
      }),
      ['/client/file.txt'],
      '/owner/workspace/.orca/drops',
      { assertCurrent: expect.any(Function) }
    )
    expect(fixture.sends[0]).toHaveBeenCalledExactlyOnceWith(
      '/owner/workspace/.orca/drops/file.txt ',
      'driving'
    )
  })
  it('uploads through the captured SSH connection', async () => {
    mocks.state.worktreesByRepo = {
      repo: [{ id: 'wt-1', repoId: 'repo', path: '/owner/workspace', hostId: 'ssh:target' }]
    }
    const fixture = mountSurface({ host: 'ssh:target' })
    drop(fixture.body)
    await settle()
    expect(mocks.resolvePaths).toHaveBeenCalledExactlyOnceWith({
      paths: ['/client/file.txt'],
      worktreePath: '/owner/workspace',
      connectionId: 'target',
      expectedExecutionHostId: 'ssh:target',
      expectedSshTargetId: 'target',
      expectedSshConnectionGeneration: 4
    })
    expect(fixture.sends[0]).toHaveBeenCalledExactlyOnceWith('/host/file.txt ', 'driving')
  })
  it('uses the existing WSL resolver for a local distro', async () => {
    mocks.state.worktreesByRepo = {
      repo: [
        {
          id: 'wt-1',
          repoId: 'repo',
          path: '\\\\wsl.localhost\\Ubuntu\\home\\user\\repo',
          hostId: 'local'
        }
      ]
    }
    const fixture = mountSurface()
    drop(fixture.body)
    await settle()
    expect(mocks.resolvePaths).toHaveBeenCalledExactlyOnceWith({
      paths: ['/client/file.txt'],
      worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\user\\repo'
    })
    expect(fixture.sends[0]).toHaveBeenCalledExactlyOnceWith('/host/file.txt ', 'driving')
  })
  it('preserves the floating terminal local cwd while another runtime is focused', async () => {
    const fixture = mountSurface({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      cwd: '/floating/cwd'
    })
    drop(fixture.title)
    await settle()
    expect(fixture.sends[0]).toHaveBeenCalledExactlyOnceWith('/client/file.txt ', 'driving')
    expect(mocks.importPaths).not.toHaveBeenCalled()
    expect(mocks.resolvePaths).not.toHaveBeenCalled()
  })
})
