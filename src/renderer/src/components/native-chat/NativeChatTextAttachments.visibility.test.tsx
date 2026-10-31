// @vitest-environment happy-dom
import { useContext, useState, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { registerTabGroupBody } from '../tab-group/tab-group-body-geometry'
import { useTerminalKeyboardShortcuts } from '../use-terminal-keyboard-shortcuts'
import { useTerminalWorkspaceFoundation } from '../use-terminal-workspace-foundation'
import type { TerminalActivationController } from '../use-terminal-activation-actions'
import StructuredAgentSessionPaneOverlayLayer from './StructuredAgentSessionPaneOverlayLayer'
import {
  NativeChatTextAttachmentScope,
  NativeChatTextAttachmentOpener,
  NativeChatTextAttachments
} from './NativeChatTextAttachments'
import { nativeChatFanoutFixture } from './native-chat-workspace-test-fixtures'
import { getDefaultSettings } from '../../../../shared/constants'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  write: vi.fn(),
  start: vi.fn(),
  append: vi.fn(),
  finish: vi.fn(),
  cancel: vi.fn(),
  fallback: false,
  web: false
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.web }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
// Keep the production overlay, NativeChatView and its visibility provider; agent execution is outside this UI contract.
vi.mock('./NativeChatStructuredSession', () => ({
  NativeChatStructuredSession: (props: NativeChatStructuredViewProps) => <ChatBody {...props} />
}))
vi.mock('./NativeChatPaneFileDropSurface', () => ({
  NativeChatPaneFileDropSurface: ({ children }: { children: ReactNode }) => <>{children}</>
}))
const path = '/host/agent-session-attachments/12345678-1234-1234-1234-123456789abc/log.txt'
const bytes = Buffer.from('selected source')
const chunk = () => ({
  snapshot: 'a'.repeat(64),
  size: bytes.length,
  contentBase64: bytes.toString('base64'),
  bytesRead: bytes.length,
  eof: true
})
const ws = 'folder:workspace-0'
const initial = useAppStore.getInitialState()
let unregister: () => void
let anchor: HTMLElement

function Editor({ tabId }: { tabId: string }) {
  const [draft, setDraft] = useState('')
  const open = useContext(NativeChatTextAttachmentOpener)
  return (
    <>
      <input
        aria-label={`draft-${tabId}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      {mocks.fallback ? (
        <NativeChatTextAttachments
          content={`@${path}`}
          structured
          runtimeContext={{ target: { kind: 'local' }, worktreeId: ws, worktreePath: '/repo/0' }}
          renderText={(text) => <span>{text}</span>}
        />
      ) : (
        <button onClick={() => open?.(path)}>Open source</button>
      )}
    </>
  )
}
function ChatBody({ tabId }: NativeChatStructuredViewProps) {
  return mocks.fallback ? (
    <Editor tabId={tabId} />
  ) : (
    <NativeChatTextAttachmentScope enabled>
      <Editor tabId={tabId} />
    </NativeChatTextAttachmentScope>
  )
}
function Host() {
  const visible = useAppStore(
    (state) => state.activeWorktreeId === ws && state.activeView === 'terminal'
  )
  const controller: TerminalActivationController = {
    ...useAppStore.getState(),
    ...useTerminalWorkspaceFoundation(),
    activeWorktreeId: ws,
    keybindings: {},
    mobileEmulatorEnabled: false,
    terminalShortcutPolicy: 'orca-first',
    tabBarOrder: undefined,
    activityTerminalPortals: [],
    foregroundTerminalTabIds: [],
    tabs: [],
    titlebarTabsTarget: null,
    worktreeFiles: [],
    worktreeBrowserTabs: [],
    worktreeClientHostedBrowserRows: [],
    getEffectiveLayoutForWorktree: vi.fn(),
    effectiveActiveLayout: undefined,
    activeWorktreeBrowserTabIdsKey: '',
    hasSplitTerminalPane: false,
    terminalProviderSnapshotCapabilityRevision: 0,
    saveDialogFileId: null,
    setSaveDialogFileId: vi.fn(),
    saveDialogFile: null,
    pendingEditorCloseQueueRef: { current: [] },
    closedReactionsRef: { current: new Map() },
    inFlightSaveFileIdRef: { current: null },
    isClosingRef: { current: false },
    closeDialogDebounceTimersRef: { current: new Set() },
    releaseCloseDialogGuardAfterDebounce: vi.fn(),
    windowCloseDialogOpen: false,
    setWindowCloseDialogOpen: vi.fn(),
    windowCloseDialogKind: 'running',
    windowCloseAfterDirtyRef: { current: null },
    confirmNativeWindowClose: vi.fn(),
    proceedToNativeWindowClose: vi.fn(),
    waitForFileClosed: vi.fn(),
    settleQueuedClose: vi.fn(),
    getNextQueuedEditorClose: vi.fn(),
    advanceEditorCloseQueue: vi.fn(),
    queueEditorCloseRequests: vi.fn(),
    handleCloseFile: vi.fn(),
    handleSaveDialogSave: vi.fn(),
    handleSaveDialogDiscard: vi.fn(),
    handleSaveDialogCancel: vi.fn(),
    measurableBackgroundWorktreeTimersRef: { current: new Map() },
    backgroundMountRevision: 0,
    setBackgroundMountRevision: vi.fn(),
    terminalParkingRevision: 0,
    setTerminalParkingRevision: vi.fn(),
    browserGuestRetentionRevision: 0,
    setBrowserGuestRetentionRevision: vi.fn(),
    parkedTerminalWorktreeIds: new Set(),
    setParkedTerminalWorktreeIds: vi.fn(),
    manuallyParkedTerminalWorktreeIds: new Set(),
    effectiveParkedTerminalWorktreeIds: new Set(),
    forceParkedTerminalWorktreeIds: new Set(),
    setForceParkedTerminalWorktreeIds: vi.fn(),
    evictionExemptTerminalTabIds: new Set(),
    setEvictionExemptTerminalTabIds: vi.fn(),
    parkedCaptureDoneRef: { current: new Set() },
    backgroundMountTabIdsByWorktreeRef: { current: new Map() },
    activationDeferredMountTabIdsByWorktreeRef: { current: new Map() },
    lastActivationWorktreeIdRef: { current: null },
    prewarmLeasesRef: { current: new Map() },
    startupTerminalTabHoldRef: { current: null },
    activationDeferralPlanRevisionRef: { current: 0 },
    anyMountedWorktreeHasLayout: false,
    activationDeferralPlanRevision: 0,
    startupTerminalTabHold: null,
    handleCloseTab: vi.fn(),
    handleCloseBrowserTab: vi.fn(),
    handlePtyExit: vi.fn(),
    closeTabBarTabs: vi.fn(),
    handleCloseOthers: vi.fn(),
    handleCloseTabsToRight: vi.fn(),
    handleCloseTabsToLeft: vi.fn(),
    handleCloseAllFiles: vi.fn(),
    handleNewBrowserTab: vi.fn(),
    handleNewBrowserTabSplitRight: vi.fn(),
    handleNewFile: vi.fn(),
    handleNewSimulatorTab: vi.fn(),
    handleNewTab: vi.fn(),
    handleOpenEntry: vi.fn(),
    handleDuplicateBrowserTab: vi.fn(),
    handleActivateTab: vi.fn(),
    handleTogglePaneExpand: vi.fn(),
    handleActivateBrowserTab: vi.fn()
  }
  useTerminalKeyboardShortcuts(controller)
  return <StructuredAgentSessionPaneOverlayLayer worktreeId={ws} isWorktreeActive={visible} />
}
beforeEach(() => {
  vi.stubGlobal('reportError', (error: unknown) => {
    throw error
  })
  vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Linux')
  anchor = document.createElement('div')
  anchor.getBoundingClientRect = () => new DOMRect(0, 32, 800, 568)
  document.body.append(anchor)
  unregister = registerTabGroupBody('g', anchor)
  const fixture = nativeChatFanoutFixture(2, 1, 0)
  fixture.unifiedTabsByWorktree[ws] = fixture.unifiedTabsByWorktree[ws].map((tab) => ({
    ...tab,
    groupId: 'g'
  }))
  useAppStore.setState(
    {
      ...initial,
      ...fixture,
      settings: getDefaultSettings('/test35636'),
      activeWorktreeId: ws,
      activeWorkspaceExecutionHostId: 'local',
      activeView: 'terminal',
      activeTabType: 'agent-session',
      groupsByWorktree: {
        [ws]: [{ id: 'g', worktreeId: ws, activeTabId: 'chat-0', tabOrder: ['chat-0', 'chat-1'] }]
      },
      activeGroupIdByWorktree: { [ws]: 'g' }
    },
    true
  )
  mocks.fallback = false
  mocks.web = false
  mocks.write.mockReset().mockResolvedValue(undefined)
  mocks.start.mockReset().mockResolvedValue({ canceled: false, transferId: 'output35636' })
  mocks.append.mockReset().mockResolvedValue(undefined)
  mocks.finish.mockReset().mockResolvedValue({ canceled: false })
  mocks.cancel.mockReset().mockResolvedValue(undefined)
  mocks.rpc
    .mockReset()
    .mockImplementation(async (_target, method) =>
      method === 'status.get'
        ? { runtimeId: 'host', capabilities: ['native-chat.text-attachment-read.v1'] }
        : chunk()
    )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: { writeClipboardText: mocks.write },
      fs: {
        startDownloadedFile: mocks.start,
        appendDownloadedFileChunk: mocks.append,
        finishDownloadedFile: mocks.finish,
        cancelDownloadedFile: mocks.cancel
      }
    }
  })
})
afterEach(() => {
  cleanup()
  unregister()
  anchor.remove()
  useAppStore.setState(initial, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const cases = [
  { fallback: false, hide: 'tab', stage: 'copy' },
  { fallback: false, hide: 'workspace', stage: 'picker' },
  { fallback: false, hide: 'pane', stage: 'append' },
  { fallback: true, hide: 'tab', stage: 'copy' },
  { fallback: true, hide: 'workspace', stage: 'web-read' },
  { fallback: true, hide: 'pane', stage: 'save-read' }
] as const
it.each(cases)(
  'retires $stage on genuine $hide hide (fallback=$fallback), preserves editor and reopens',
  async ({ fallback, hide, stage }) => {
    mocks.fallback = fallback
    const webClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const webUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:35636')
    const view = render(<Host />)
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'draft-chat-0' })
    fireEvent.change(input, { target: { value: 'editor state survives hide' } })
    input.focus()
    const open = () =>
      fireEvent.click(screen.getByRole('button', { name: fallback ? 'log.txt' : 'Open source' }))
    const ready = async () =>
      waitFor(() =>
        expect(screen.getByRole('button', { name: 'Copy contents' }).hasAttribute('disabled')).toBe(
          false
        )
      )
    open()
    await ready()
    const delayed = Promise.withResolvers<unknown>()
    const waiting = Promise.withResolvers<void>()
    if (stage === 'picker') {
      mocks.start.mockImplementationOnce(() => {
        waiting.resolve()
        return delayed.promise
      })
    } else if (stage === 'append') {
      mocks.append.mockImplementationOnce(() => {
        waiting.resolve()
        return delayed.promise
      })
    } else {
      mocks.rpc.mockImplementationOnce(() => {
        waiting.resolve()
        return delayed.promise
      })
    }
    mocks.web = stage === 'web-read'
    fireEvent.click(
      screen.getByRole('button', { name: stage === 'copy' ? 'Copy contents' : 'Save file' })
    )
    await waiting.promise
    const dispatched = {
      reads: mocks.rpc.mock.calls.length,
      starts: mocks.start.mock.calls.length,
      appends: mocks.append.mock.calls.length
    }
    if (hide === 'tab') {
      // The application command, not a mocked visibility handler, activates the next retained chat.
      fireEvent.keyDown(screen.getByRole('dialog'), {
        key: ']',
        code: 'BracketRight',
        ctrlKey: true,
        altKey: true
      })
      expect(useAppStore.getState().getActiveTab(ws)?.id).toBe('chat-1')
    } else {
      await act(async () => {
        if (hide === 'workspace') {
          useAppStore.setState({ activeWorktreeId: 'folder:another' })
        } else {
          useAppStore.getState().setActiveView('tasks')
        }
      })
    }
    await act(async () => {})
    const retained = view.container.querySelector(
      '[data-structured-agent-session-overlay-tab-id="chat-0"]'
    )
    expect(retained?.hasAttribute('inert')).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () =>
      delayed.resolve(
        stage === 'picker'
          ? { canceled: false, transferId: 'late35636' }
          : stage === 'append'
            ? undefined
            : chunk()
      )
    )
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.finish).not.toHaveBeenCalled()
    expect(webClick).not.toHaveBeenCalled()
    expect(webUrl).not.toHaveBeenCalled()
    expect(mocks.rpc).toHaveBeenCalledTimes(dispatched.reads)
    expect(mocks.start).toHaveBeenCalledTimes(dispatched.starts)
    expect(mocks.append).toHaveBeenCalledTimes(dispatched.appends)
    if (stage === 'picker' || stage === 'append') {
      expect(mocks.cancel).toHaveBeenCalledWith({
        transferId: stage === 'picker' ? 'late35636' : 'output35636'
      })
    }
    await act(async () => {
      useAppStore.setState({ activeWorktreeId: ws, activeView: 'terminal' })
      if (hide === 'tab') {
        fireEvent.keyDown(document, { key: '[', code: 'BracketLeft', ctrlKey: true, altKey: true })
      }
    })
    const returned = screen.getByRole<HTMLInputElement>('textbox', { name: 'draft-chat-0' })
    expect(returned).toBe(input)
    expect(returned.value).toBe('editor state survives hide')
    returned.focus()
    expect(document.activeElement).toBe(input)
    expect(screen.queryByRole('dialog')).toBeNull()
    mocks.web = false
    open()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Copy contents' }))
    await waitFor(() => expect(mocks.write).toHaveBeenCalledExactlyOnceWith('selected source'))
  }
)
