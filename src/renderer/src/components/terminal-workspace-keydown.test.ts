// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleSwitchTabAcrossAllTypes } from '../hooks/ipc-tab-switch'
import {
  createFloatingWorkspaceTerminalTab,
  switchFloatingWorkspaceTab
} from '@/lib/floating-workspace-terminal-actions'
import { showTerminalShortcutCaptureNotification } from '@/lib/terminal-shortcut-capture-notification'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'
import type { Tab } from '../../../shared/tab-types'
import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import {
  ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT,
  type EditorRequestCmdSaveDetail
} from './editor/editor-autosave'
import { createTestStore, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import { useTerminalKeyboardShortcuts } from './use-terminal-keyboard-shortcuts'
import { agentMenuShortcutLabels } from './tab-bar/agent-menu-shortcut-labels'
import { handleTerminalWorkspaceKeyDown } from './terminal-workspace-keydown'
import type { TerminalActivationController } from './use-terminal-activation-actions'
import type * as AgentTabShortcuts from './terminal-agent-tab-shortcut'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { TerminalAgentTabShortcut } from './terminal-agent-tab-shortcut'
import { useTerminalBulkCloseActions } from './use-terminal-bulk-close-actions'
import { makeOpenFile, makeUnifiedTab } from '../store/slices/store-session-test-harness'

const confirmBulkClose = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
vi.mock('./confirmation-dialog-context', () => ({
  useConfirmationDialog: () => confirmBulkClose
}))

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  closeTerminalTab: vi.fn(),
  closeStructuredAgentSession: vi.fn(async () => 'closed'),
  callRuntimeRpc: vi.fn(async () => ({ ok: true })),
  cancelStructuredAgentLaunch: vi.fn(),
  structuredSessionBusy: vi.fn<() => boolean>(),
  floatingFocused: false,
  targetInsideFloatingPanel: false,
  resolveAgentShortcut: vi.fn<
    (
      args: Parameters<typeof AgentTabShortcuts.resolveTerminalAgentTabShortcut>[0]
    ) => TerminalAgentTabShortcut
  >(() => ({ actionId: null, agent: null })),
  actualResolveAgentShortcut: vi.fn<typeof AgentTabShortcuts.resolveTerminalAgentTabShortcut>(),
  launchAgentInNewTab: vi.fn()
}))

vi.mock('@/lib/agent-session/structured-agent-session-busy', async () => ({
  admitStructuredAgentSession: (
    await import('@/store/slices/store-session-test-harness')
  ).admissionFromBusy(mocks.structuredSessionBusy)
}))

vi.mock('../store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('../hooks/ipc-tab-switch', () => ({
  handleSwitchRecentTab: vi.fn(),
  handleSwitchTab: vi.fn(),
  handleSwitchTabAcrossAllTypes: vi.fn(),
  handleSwitchTerminalTab: vi.fn()
}))
vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  createFloatingWorkspaceBrowserTab: vi.fn(),
  createFloatingWorkspaceMarkdownTab: vi.fn(),
  createFloatingWorkspaceTerminalTab: vi.fn(),
  handleEmptyFloatingWorkspacePanelCloseShortcut: () => false,
  isEventTargetInsideFloatingWorkspacePanel: () => mocks.targetInsideFloatingPanel,
  isFloatingWorkspacePanelFocused: () => mocks.floatingFocused,
  switchFloatingWorkspaceTab: vi.fn()
}))
vi.mock('@/lib/terminal-shortcut-capture-notification', () => ({
  showTerminalShortcutCaptureNotification: vi.fn()
}))
vi.mock('./terminal-agent-tab-shortcut', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentTabShortcuts>()
  mocks.actualResolveAgentShortcut.mockImplementation(actual.resolveTerminalAgentTabShortcut)
  return { ...actual, resolveTerminalAgentTabShortcut: mocks.resolveAgentShortcut }
})
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launchAgentInNewTab }))

vi.mock('./terminal/terminal-tab-actions', () => ({ closeTerminalTab: mocks.closeTerminalTab }))
vi.mock('@/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: mocks.closeStructuredAgentSession
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/lib/structured-agent-session-launch', () => ({
  cancelStructuredAgentLaunch: mocks.cancelStructuredAgentLaunch
}))
vi.mock('@/runtime/runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (id: string) => `id:${id}`
}))
vi.mock('@/runtime/browser-workspace-tab-close', () => ({
  closeBrowserWorkspaceTabOnHosts: () => ({ closesLocally: true, removesVisibleTab: true })
}))
vi.mock('../store/slices/browser-webview-cleanup', () => ({ destroyWorkspaceWebviews: vi.fn() }))

const controller = {
  activeWorktreeId: 'repo-1::/repo/worktree',
  handleCloseAllFiles: vi.fn(),
  handleCloseBrowserTab: vi.fn(),
  handleCloseFile: vi.fn(),
  handleNewBrowserTab: vi.fn(),
  handleNewFile: vi.fn(),
  handleNewSimulatorTab: vi.fn(),
  handleNewTab: vi.fn(),
  keybindings: undefined,
  mobileEmulatorEnabled: false,
  terminalShortcutPolicy: 'orca-first'
} as unknown as TerminalActivationController

function pressCmdS(): (EditorRequestCmdSaveDetail | undefined)[] {
  const details: (EditorRequestCmdSaveDetail | undefined)[] = []
  const listener = (event: Event): void => {
    details.push((event as CustomEvent<EditorRequestCmdSaveDetail>).detail ?? undefined)
  }
  window.addEventListener(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, listener)
  const target = document.createElement('div')
  document.body.appendChild(target)
  const event = new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true })
  Object.defineProperty(event, 'target', { value: target })
  try {
    handleTerminalWorkspaceKeyDown(event, controller, 'darwin')
  } finally {
    window.removeEventListener(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, listener)
    target.remove()
  }
  return details
}

describe('handleTerminalWorkspaceKeyDown editor.save', () => {
  beforeEach(() => {
    mocks.floatingFocused = false
    mocks.targetInsideFloatingPanel = false
    mocks.state = {
      activeView: 'terminal',
      activeTabType: 'editor',
      activeFileId: 'file-1',
      getActiveTab: () => null
    }
  })

  it('dispatches the save request with the resolved file id', () => {
    expect(pressCmdS()).toEqual([{ fileId: 'file-1' }])
  })

  it('resolves the floating panel editor when the panel owns the event', () => {
    mocks.targetInsideFloatingPanel = true
    mocks.state.getActiveTab = (worktreeId: string) =>
      worktreeId === FLOATING_TERMINAL_WORKTREE_ID
        ? { contentType: 'editor', entityId: 'floating-file' }
        : null
    expect(pressCmdS()).toEqual([{ fileId: 'floating-file' }])
  })

  it('does not swallow the chord outside the workspace view', () => {
    mocks.state.activeView = 'tasks'
    expect(pressCmdS()).toEqual([])
  })
})

describe('tab.close uses the unified active tab', () => {
  const worktreeId = controller.activeWorktreeId!
  let tab: Tab
  const closeUnifiedTab = vi.fn()
  const closeFile = vi.fn()
  const closeBrowserTab = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.structuredSessionBusy.mockReturnValue(false)
    mocks.floatingFocused = false
    mocks.targetInsideFloatingPanel = false
    tab = {
      id: 'chat-tab',
      entityId: 'chat-session',
      worktreeId,
      groupId: 'right-group',
      contentType: 'agent-session',
      label: 'Chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    mocks.state = {
      activeView: 'terminal',
      activeWorktreeId: worktreeId,
      settings: getDefaultSettings('/tmp/pr-34236-keyboard'),
      // The old terminal mirror can lag behind focus in a split group.
      activeTabType: 'terminal',
      activeTabId: 'other-terminal',
      activeFileId: 'other-file',
      activeBrowserTabId: 'other-browser',
      getActiveTab: () => tab,
      unifiedTabsByWorktree: { [worktreeId]: [tab] },
      openFiles: [],
      editorBufferIdOf: {},
      editorBufferViews: {},
      browserPagesByWorkspace: {},
      closeUnifiedTab,
      closeFile,
      closeBrowserTab,
      reconcileWorktreeTabModel: () => ({ renderableTabCount: 1 }),
      requestPinnedTabCloseConfirm: vi.fn(),
      setActiveWorktree: vi.fn()
    }
  })

  afterEach(() => {
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
  })

  function close(platform: NodeJS.Platform = 'darwin', terminalFocus = false): KeyboardEvent {
    const target = document.createElement('textarea')
    if (terminalFocus) {
      target.classList.add('xterm-helper-textarea')
    }
    const event = new KeyboardEvent('keydown', {
      key: 'w',
      metaKey: platform === 'darwin',
      ctrlKey: platform !== 'darwin',
      cancelable: true
    })
    Object.defineProperty(event, 'target', { value: target })
    handleTerminalWorkspaceKeyDown(event, controller, platform)
    return event
  }

  it.each(
    (['darwin', 'win32', 'linux'] as const).flatMap((platform) =>
      [false, true].map((busy) => ({ platform, busy }))
    )
  )('routes native chat close on $platform with busy=$busy', async ({ platform, busy }) => {
    mocks.structuredSessionBusy.mockReturnValue(busy)
    expect(close(platform).defaultPrevented).toBe(true)
    if (busy) {
      expect(closeUnifiedTab).not.toHaveBeenCalled()
      useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()
    }
    await vi.waitFor(() => expect(closeUnifiedTab).toHaveBeenCalledWith(tab.id))
    // Why: the unified store action owns cancellation and host retirement for every close path.
    expect(mocks.closeStructuredAgentSession).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(mocks.cancelStructuredAgentLaunch).not.toHaveBeenCalled()
    expect(mocks.closeTerminalTab).not.toHaveBeenCalled()
  })

  it.each(['editor', 'diff', 'conflict-review', 'check-details', 'browser', 'simulator'] as const)(
    'closes the focused %s tab through the same command',
    (contentType) => {
      tab.contentType = contentType
      close()
      expect(closeUnifiedTab).toHaveBeenCalledWith(
        tab.id,
        ...(contentType === 'browser' ? [undefined] : [])
      )
      expect(controller.handleCloseFile).not.toHaveBeenCalled()
      expect(controller.handleCloseBrowserTab).not.toHaveBeenCalled()
    }
  )

  it('leaves a focused terminal split pane to its pane close handler', () => {
    tab.contentType = 'terminal'
    expect(close('darwin', true).defaultPrevented).toBe(false)
    expect(mocks.closeTerminalTab).not.toHaveBeenCalled()
  })

  it('closes a terminal tab from its native chat overlay through terminal teardown', () => {
    tab.contentType = 'terminal'
    tab.viewMode = 'chat'
    close()
    expect(mocks.closeTerminalTab).toHaveBeenCalledWith(tab.entityId, {
      onClosed: expect.any(Function)
    })
  })

  it('waits for pinned-tab then active-work confirmation before closing', () => {
    tab.isPinned = true
    mocks.structuredSessionBusy.mockReturnValue(true)
    close()
    expect(mocks.closeStructuredAgentSession).not.toHaveBeenCalled()
    expect(closeUnifiedTab).not.toHaveBeenCalled()
    const request = vi.mocked(mocks.state.requestPinnedTabCloseConfirm as ReturnType<typeof vi.fn>)
      .mock.calls[0][0]
    expect(useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm).toBeNull()
    request.onConfirm()
    expect(closeUnifiedTab).not.toHaveBeenCalled()
    expect(
      useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm
    ).toMatchObject({
      copyKind: 'chat-agent'
    })
    useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()
    expect(closeUnifiedTab).toHaveBeenCalledExactlyOnceWith(tab.id)
  })

  it('leaves the chord to an agent terminal preview dialog over a workspace editor', () => {
    tab.contentType = 'editor'
    const preview = document.createElement('div')
    preview.setAttribute('data-agent-terminal-preview', '')
    const target = document.createElement('textarea')
    target.classList.add('xterm-helper-textarea')
    preview.appendChild(target)
    const event = new KeyboardEvent('keydown', { key: 'w', metaKey: true, cancelable: true })
    Object.defineProperty(event, 'target', { value: target })
    handleTerminalWorkspaceKeyDown(event, controller, 'darwin')
    expect(event.defaultPrevented).toBe(false)
    expect(closeUnifiedTab).not.toHaveBeenCalled()
  })

  it('does not close the main workspace tab while the floating panel owns focus', () => {
    mocks.floatingFocused = true
    expect(close().defaultPrevented).toBe(false)
    expect(mocks.closeStructuredAgentSession).not.toHaveBeenCalled()
  })

  it('preserves pinned tabs during a bulk close without prompting', () => {
    tab.isPinned = true
    dispatchWorkspaceTabCommand({
      type: 'close',
      target: { kind: 'tab', worktreeId, tabId: tab.id },
      bulk: true
    })
    expect(mocks.state.requestPinnedTabCloseConfirm).not.toHaveBeenCalled()
    expect(mocks.closeStructuredAgentSession).not.toHaveBeenCalled()
  })

  it('does not substitute the ambient tab for a stale explicit target', () => {
    expect(
      dispatchWorkspaceTabCommand({
        type: 'close',
        target: { kind: 'tab', worktreeId, tabId: 'removed' }
      })
    ).toBe(false)
    expect(mocks.closeStructuredAgentSession).not.toHaveBeenCalled()
  })

  it('does not close another group from an empty focused split', () => {
    mocks.state.getActiveTab = () => null
    mocks.state.activeGroupIdByWorktree = { [worktreeId]: 'empty-group' }
    mocks.state.groupsByWorktree = { [worktreeId]: [{ id: 'empty-group', activeTabId: null }] }
    tab.contentType = 'terminal'
    mocks.state.activeTabId = tab.entityId
    expect(close().defaultPrevented).toBe(false)
    expect(mocks.closeTerminalTab).not.toHaveBeenCalled()
  })

  it('closes only the focused copy of an editor shared between split groups', () => {
    tab.contentType = 'editor'
    mocks.state.unifiedTabsByWorktree = {
      [worktreeId]: [tab, { ...tab, id: 'left-copy', groupId: 'left-group' }]
    }
    close()
    expect(closeUnifiedTab).toHaveBeenCalledWith(tab.id)
    expect(closeFile).not.toHaveBeenCalled()
  })
})

describe('shared tab navigation routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.floatingFocused = false
    mocks.targetInsideFloatingPanel = false
    mocks.state = { activeWorktreeId: controller.activeWorktreeId }
  })

  function nextTab(repeat = false): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key: ']',
      metaKey: true,
      shiftKey: true,
      cancelable: true,
      repeat
    })
    handleTerminalWorkspaceKeyDown(event, controller, 'darwin')
    return event
  }

  it('claims a held tab chord on every repeat but switches once', () => {
    nextTab()
    const repeat = nextTab(true)
    expect(repeat.defaultPrevented).toBe(true)
    expect(handleSwitchTabAcrossAllTypes).toHaveBeenCalledTimes(1)
  })

  it('sends the keyboard and IPC navigation intent to the same workspace operation', () => {
    nextTab()
    dispatchWorkspaceTabCommand({ type: 'switch', direction: 1, scope: 'all-types' })
    expect(handleSwitchTabAcrossAllTypes).toHaveBeenCalledTimes(2)
    expect(handleSwitchTabAcrossAllTypes).toHaveBeenLastCalledWith(1)
    expect(switchFloatingWorkspaceTab).not.toHaveBeenCalled()
  })

  it('routes both entry points to the floating panel when it owns focus', () => {
    mocks.floatingFocused = true
    nextTab()
    dispatchWorkspaceTabCommand({ type: 'switch', direction: 1, scope: 'all-types' })
    expect(switchFloatingWorkspaceTab).toHaveBeenCalledTimes(2)
    expect(switchFloatingWorkspaceTab).toHaveBeenLastCalledWith(mocks.state, 1, 'all-types')
    expect(handleSwitchTabAcrossAllTypes).not.toHaveBeenCalled()
  })
})

describe('tab.closeAll confirmation', () => {
  const worktreeId = controller.activeWorktreeId!
  const closeFile = vi.fn()
  const queueEditorCloseRequests = vi.fn()
  let settle: (confirmed: boolean) => void

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.floatingFocused = false
    mocks.targetInsideFloatingPanel = false
    mocks.state = {
      activeView: 'terminal',
      activeTabType: 'editor',
      openFiles: [makeOpenFile({ id: 'file-1', worktreeId })],
      editorBufferIdOf: {},
      editorBufferViews: {},
      unifiedTabsByWorktree: { [worktreeId]: [] },
      getActiveTab: () => null
    }
    confirmBulkClose.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
  })
  afterEach(cleanup)

  function closeAll(platform: NodeJS.Platform = 'darwin') {
    const { result } = renderHook(() =>
      useTerminalBulkCloseActions({
        activeWorktreeId: worktreeId,
        closeFile,
        queueEditorCloseRequests,
        closeTab: vi.fn(),
        closeBrowserTab: vi.fn()
      })
    )
    const event = new KeyboardEvent('keydown', {
      key: 'w',
      code: 'KeyW',
      altKey: true,
      cancelable: true,
      metaKey: platform === 'darwin',
      ctrlKey: platform !== 'darwin'
    })
    act(() => handleTerminalWorkspaceKeyDown(event, { ...controller, ...result.current }, platform))
    return result
  }

  it.each(['darwin', 'linux', 'win32'] as const)(
    'waits for confirmation before closing files from the %s shortcut',
    async (platform) => {
      closeAll(platform)
      expect(confirmBulkClose).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          title: 'Close all editor tabs?'
        })
      )
      expect(closeFile).not.toHaveBeenCalled()
      await act(async () => {
        settle(true)
      })
      expect(closeFile).toHaveBeenCalledExactlyOnceWith('file-1')
    }
  )

  it('does not close files when the shortcut confirmation is cancelled', async () => {
    closeAll()
    await act(async () => {
      settle(false)
    })
    expect(closeFile).not.toHaveBeenCalled()
    expect(queueEditorCloseRequests).not.toHaveBeenCalled()
  })

  it('queues newly dirty files without closing files created after the request', async () => {
    closeAll()
    mocks.state.openFiles = [
      makeOpenFile({ id: 'file-1', worktreeId, isDirty: true }),
      makeOpenFile({ id: 'new-file', worktreeId })
    ]
    await act(async () => {
      settle(true)
    })
    expect(closeFile).not.toHaveBeenCalled()
    expect(queueEditorCloseRequests).toHaveBeenCalledExactlyOnceWith(['file-1'])
  })

  it('skips files pinned while shortcut confirmation is pending', async () => {
    closeAll()
    mocks.state.unifiedTabsByWorktree = {
      [worktreeId]: [
        makeUnifiedTab({
          id: 'pinned-view',
          entityId: 'file-1',
          worktreeId,
          groupId: 'group',
          contentType: 'editor',
          isPinned: true
        })
      ]
    }
    await act(async () => {
      settle(true)
    })
    expect(queueEditorCloseRequests).not.toHaveBeenCalled()
    expect(closeFile).not.toHaveBeenCalled()
  })
})

describe('agent tab shortcuts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.floatingFocused = false
    mocks.state = {
      activeGroupIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'floating-group' },
      groupsByWorktree: {}
    }
    mocks.resolveAgentShortcut.mockReturnValueOnce({
      actionId: 'tab.newAgent.claude',
      agent: 'claude'
    })
  })

  function pressAgentShortcut(): void {
    handleTerminalWorkspaceKeyDown(
      new KeyboardEvent('keydown', { key: '1', ctrlKey: true, cancelable: true }),
      controller,
      'darwin'
    )
  }

  it('opens the agent in the active worktree when the floating panel is not focused', () => {
    pressAgentShortcut()

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agent: 'claude', worktreeId: controller.activeWorktreeId })
    )
  })

  it('opens the agent in the floating workspace when its panel owns focus', () => {
    mocks.floatingFocused = true

    pressAgentShortcut()

    expect(mocks.resolveAgentShortcut).toHaveBeenCalledWith(
      expect.objectContaining({ activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID })
    )
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agent: 'claude',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        groupId: 'floating-group'
      })
    )
  })
})

describe('agent shortcut delivery and deferred ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveAgentShortcut.mockReset()
    mocks.floatingFocused = false
    const store = createTestStore()
    store.setState({
      activeWorktreeId: controller.activeWorktreeId,
      repos: [TEST_REPO],
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id: controller.activeWorktreeId!, repoId: TEST_REPO.id })]
      },
      detectedAgentIds: ['codex'],
      settings: { ...store.getState().settings!, experimentalNativeChat: false }
    })
    mocks.state = { ...store.getState() }
  })
  afterEach(cleanup)

  it.each([false, true])(
    'opens a terminal from a focused terminal through the shared resolver (floating: %s)',
    (floating) => {
      mocks.resolveAgentShortcut.mockImplementation(mocks.actualResolveAgentShortcut)
      mocks.floatingFocused = floating
      const press = (repeat: boolean): KeyboardEvent => {
        const target = document.createElement('textarea')
        target.classList.add('xterm-helper-textarea')
        const event = new KeyboardEvent('keydown', {
          key: 't',
          code: 'KeyT',
          metaKey: true,
          cancelable: true,
          repeat
        })
        Object.defineProperty(event, 'target', { value: target })
        handleTerminalWorkspaceKeyDown(event, controller, 'darwin')
        return event
      }
      expect(press(true).defaultPrevented).toBe(false)
      expect(press(false).defaultPrevented).toBe(true)
      expect(showTerminalShortcutCaptureNotification).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ actionId: 'tab.newTerminal' })
      )
      expect(createFloatingWorkspaceTerminalTab).toHaveBeenCalledTimes(floating ? 1 : 0)
      expect(controller.handleNewTab).toHaveBeenCalledTimes(floating ? 0 : 1)
      expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
    }
  )

  it('omits an undelivered double-tap gesture while a real ordinary chord still launches', () => {
    mocks.resolveAgentShortcut.mockImplementation(mocks.actualResolveAgentShortcut)
    const keys = { 'tab.newAgent': [], 'tab.newAgent.codex': ['DoubleTap+Ctrl', 'Mod+Shift+X'] }
    renderHook(() => useTerminalKeyboardShortcuts({ ...controller, keybindings: keys }))
    for (let tap = 0; tap < 2; tap++) {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true })
      )
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft' }))
    }
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
    expect(agentMenuShortcutLabels(controller.activeWorktreeId!, keys, 'linux').get('codex')).toBe(
      'Ctrl+⇧+X'
    )
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'x',
        code: 'KeyX',
        ctrlKey: true,
        shiftKey: true,
        cancelable: true
      })
    )
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agent: 'codex' })
    )
  })

  it.each(['workspace', 'host'])(
    'drops a pending ordinary launch after its %s changed',
    async (changed) => {
      const detection = Promise.withResolvers<TuiAgent | null>()
      mocks.resolveAgentShortcut.mockReturnValue({
        actionId: 'tab.newAgent',
        agent: null,
        pendingAgent: detection.promise
      })
      handleTerminalWorkspaceKeyDown(
        new KeyboardEvent('keydown', { key: 't', metaKey: true, altKey: true }),
        controller,
        'darwin'
      )
      if (changed === 'workspace') {
        mocks.state.activeWorktreeId = 'another-workspace'
      } else {
        mocks.state.worktreesByRepo = {
          [TEST_REPO.id]: [
            makeWorktree({
              id: controller.activeWorktreeId!,
              repoId: TEST_REPO.id,
              hostId: 'runtime:other'
            })
          ]
        }
      }
      detection.resolve('codex')
      await detection.promise
      expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
    }
  )
})
