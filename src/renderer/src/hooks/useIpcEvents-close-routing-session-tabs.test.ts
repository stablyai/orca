import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useIpcEventsForCloseRouting,
  type RequestTabCloseListener,
  type CloseActiveTabListener,
  type CloseTerminalListener,
  type CloseSessionTabListener,
  type TerminalTabCloseRequestListener
} from './ipc-events-close-routing-test-harness'

const { closeTerminalTabMock } = vi.hoisted(() => ({
  closeTerminalTabMock: vi.fn()
}))

vi.mock('@/components/terminal/terminal-tab-actions', () => ({
  closeTerminalTab: closeTerminalTabMock
}))

describe('useIpcEvents browser tab close routing', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    // Undo a partial mock of this module leaked by an earlier describe so the real
    // resolveFloatingWorkspaceBrowserWorkspaceId (source validation) is used here.
    vi.doUnmock('@/lib/floating-workspace-terminal-actions')
    closeTerminalTabMock.mockReset()
  })

  it('removes the file from openFiles when a companion closes an editor session tab', async () => {
    const closeSessionTabListenerRef: { current: CloseSessionTabListener | null } = {
      current: null
    }
    const closeFile = vi.fn()
    const closeUnifiedTab = vi.fn()

    await useIpcEventsForCloseRouting({
      closeSessionTabListenerRef,
      getState: () => ({
        recordClientHostedBrowserCloseIntents: vi.fn(),
        closeFile,
        closeUnifiedTab,
        browserTabsByWorktree: {},
        unifiedTabsByWorktree: {
          'wt-1': [{ id: 'host-tab-1', entityId: 'file-1', contentType: 'editor', isPinned: false }]
        }
      })
    })

    closeSessionTabListenerRef.current?.({ tabId: 'host-tab-1', worktreeId: 'wt-1' })

    // Why: closeUnifiedTab alone would leave the file in openFiles, which the host
    // republishes — so the editor close must go through closeFile.
    expect(closeFile).toHaveBeenCalledWith('file-1')
    expect(closeUnifiedTab).not.toHaveBeenCalled()
  })

  it('keeps closeUnifiedTab for a non-editor session tab closed by a companion', async () => {
    const closeSessionTabListenerRef: { current: CloseSessionTabListener | null } = {
      current: null
    }
    const closeFile = vi.fn()
    const closeUnifiedTab = vi.fn()

    await useIpcEventsForCloseRouting({
      closeSessionTabListenerRef,
      getState: () => ({
        recordClientHostedBrowserCloseIntents: vi.fn(),
        closeFile,
        closeUnifiedTab,
        browserTabsByWorktree: {},
        unifiedTabsByWorktree: {
          'wt-1': [
            { id: 'sim-tab-1', entityId: 'sim-1', contentType: 'simulator', isPinned: false }
          ]
        }
      })
    })

    closeSessionTabListenerRef.current?.({ tabId: 'sim-tab-1', worktreeId: 'wt-1' })

    // Why: only editor tabs need the closeFile (openFiles) path; other content types
    // must keep closeUnifiedTab so the editor-only routing stays scoped.
    expect(closeUnifiedTab).toHaveBeenCalledWith('sim-tab-1')
    expect(closeFile).not.toHaveBeenCalled()
  })

  it('delegates terminal close IPC without a pane id to the shared terminal close flow', async () => {
    const closeTerminalListenerRef: { current: CloseTerminalListener | null } = { current: null }

    await useIpcEventsForCloseRouting({
      closeTerminalListenerRef,
      getState: () => ({})
    })

    closeTerminalListenerRef.current?.({ tabId: 'terminal-1' })

    // The CLI/RPC caller is answered immediately, so this close must never raise a modal.
    expect(closeTerminalTabMock).toHaveBeenCalledWith('terminal-1', {
      skipRunningProcessConfirm: true
    })
  })

  it('acknowledges whole-tab close only after the fresh session is durably persisted', async () => {
    const listenerRef: { current: TerminalTabCloseRequestListener | null } = { current: null }
    let finishPersist!: () => void
    const persistWorkspaceSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPersist = resolve
        })
    )
    const respondTerminalTabClose = vi.fn()
    closeTerminalTabMock.mockImplementation((_tabId: string, options: { onClosed?: () => void }) =>
      options.onClosed?.()
    )
    await useIpcEventsForCloseRouting({
      getState: () => ({}),
      terminalTabCloseRequestListenerRef: listenerRef,
      respondTerminalTabClose,
      persistWorkspaceSession
    })

    listenerRef.current?.({
      requestId: 'close-1',
      tabId: 'terminal-1',
      localPtyTeardownOwnedExternally: true
    })
    await Promise.resolve()

    expect(closeTerminalTabMock).toHaveBeenCalledWith(
      'terminal-1',
      expect.objectContaining({
        rejectPinned: true,
        localPtyTeardownOwnedExternally: true
      })
    )
    expect(persistWorkspaceSession).toHaveBeenCalledTimes(1)
    expect(respondTerminalTabClose).not.toHaveBeenCalled()

    finishPersist()
    await vi.waitFor(() =>
      expect(respondTerminalTabClose).toHaveBeenCalledWith({ requestId: 'close-1' })
    )
  })

  it('rejects a pinned whole-tab close without persisting or reporting success', async () => {
    const listenerRef: { current: TerminalTabCloseRequestListener | null } = { current: null }
    const persistWorkspaceSession = vi.fn().mockResolvedValue(undefined)
    const respondTerminalTabClose = vi.fn()
    closeTerminalTabMock.mockImplementation((_tabId: string, options: { onCancel?: () => void }) =>
      options.onCancel?.()
    )
    await useIpcEventsForCloseRouting({
      getState: () => ({}),
      terminalTabCloseRequestListenerRef: listenerRef,
      respondTerminalTabClose,
      persistWorkspaceSession
    })

    listenerRef.current?.({ requestId: 'close-pinned', tabId: 'terminal-pinned' })

    expect(persistWorkspaceSession).not.toHaveBeenCalled()
    expect(respondTerminalTabClose).toHaveBeenCalledWith({
      requestId: 'close-pinned',
      error: 'terminal_tab_pinned'
    })
  })

  it('confirms before closing a pinned active browser tab from the native close event', async () => {
    const closeActiveTabListenerRef: { current: CloseActiveTabListener | null } = { current: null }
    const closeBrowserTab = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()

    await useIpcEventsForCloseRouting({
      closeActiveTabListenerRef,
      getState: () => ({
        recordClientHostedBrowserCloseIntents: vi.fn(),
        closeBrowserTab,
        requestPinnedTabCloseConfirm,
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'browser-unified-1',
              entityId: 'workspace-1',
              contentType: 'browser',
              label: 'Docs',
              isPinned: true
            }
          ]
        }
      })
    })

    closeActiveTabListenerRef.current?.()

    expect(closeBrowserTab).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ tabLabel: 'Docs', onConfirm: expect.any(Function) })
    )

    const { onConfirm } = requestPinnedTabCloseConfirm.mock.calls[0][0] as { onConfirm: () => void }
    onConfirm()

    expect(closeBrowserTab).toHaveBeenCalledWith('workspace-1', undefined)
  })

  it('confirms CLI workspace browser closes and replies after confirmation', async () => {
    const requestTabCloseListenerRef: { current: RequestTabCloseListener | null } = {
      current: null
    }
    const closeBrowserTab = vi.fn()
    const replyTabClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()

    await useIpcEventsForCloseRouting({
      requestTabCloseListenerRef,
      replyTabClose,
      getState: () => ({
        recordClientHostedBrowserCloseIntents: vi.fn(),
        closeBrowserTab,
        requestPinnedTabCloseConfirm,
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'browser-unified-1',
              entityId: 'workspace-1',
              contentType: 'browser',
              label: 'Docs',
              isPinned: true
            }
          ]
        }
      })
    })

    requestTabCloseListenerRef.current?.({ requestId: 'req-pinned', tabId: 'workspace-1' })

    expect(closeBrowserTab).not.toHaveBeenCalled()
    expect(replyTabClose).not.toHaveBeenCalledWith({ requestId: 'req-pinned' })
    const request = requestPinnedTabCloseConfirm.mock.calls[0][0] as {
      onConfirm: () => void
      onCancel: () => void
    }

    request.onConfirm()

    expect(closeBrowserTab).toHaveBeenCalledWith('workspace-1')
    expect(replyTabClose).toHaveBeenCalledWith({ requestId: 'req-pinned' })
  })

  it('replies with the pinned error when a CLI browser close is canceled', async () => {
    const requestTabCloseListenerRef: { current: RequestTabCloseListener | null } = {
      current: null
    }
    const closeBrowserTab = vi.fn()
    const replyTabClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()

    await useIpcEventsForCloseRouting({
      requestTabCloseListenerRef,
      replyTabClose,
      getState: () => ({
        recordClientHostedBrowserCloseIntents: vi.fn(),
        closeBrowserTab,
        requestPinnedTabCloseConfirm,
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'browser-unified-1',
              entityId: 'workspace-1',
              contentType: 'browser',
              label: 'Docs',
              isPinned: true
            }
          ]
        }
      })
    })

    requestTabCloseListenerRef.current?.({ requestId: 'req-cancel', tabId: 'workspace-1' })
    const request = requestPinnedTabCloseConfirm.mock.calls[0][0] as {
      onCancel: () => void
    }

    request.onCancel()

    expect(closeBrowserTab).not.toHaveBeenCalled()
    expect(replyTabClose).toHaveBeenCalledWith({
      requestId: 'req-cancel',
      error: 'Browser tab workspace-1 is pinned'
    })
  })

  it('lets CLI browser closes bypass confirmation when the pinned-tab setting is off', async () => {
    const requestTabCloseListenerRef: { current: RequestTabCloseListener | null } = {
      current: null
    }
    const closeBrowserTab = vi.fn()
    const replyTabClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()

    await useIpcEventsForCloseRouting({
      requestTabCloseListenerRef,
      replyTabClose,
      getState: () => ({
        recordClientHostedBrowserCloseIntents: vi.fn(),
        closeBrowserTab,
        requestPinnedTabCloseConfirm,
        settings: {
          activeRuntimeEnvironmentId: null,
          confirmClosePinnedTab: false,
          terminalFontSize: 13
        },
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'browser-unified-1',
              entityId: 'workspace-1',
              contentType: 'browser',
              label: 'Docs',
              isPinned: true
            }
          ]
        }
      })
    })

    requestTabCloseListenerRef.current?.({ requestId: 'req-off', tabId: 'workspace-1' })

    expect(requestPinnedTabCloseConfirm).not.toHaveBeenCalled()
    expect(closeBrowserTab).toHaveBeenCalledWith('workspace-1')
    expect(replyTabClose).toHaveBeenCalledWith({ requestId: 'req-off' })
  })

  it('guards a CLI last-page close for a pinned browser workspace', async () => {
    const requestTabCloseListenerRef: { current: RequestTabCloseListener | null } = {
      current: null
    }
    const closeBrowserTab = vi.fn()
    const closeBrowserPage = vi.fn()
    const replyTabClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()

    await useIpcEventsForCloseRouting({
      requestTabCloseListenerRef,
      replyTabClose,
      getState: () => ({
        recordClientHostedBrowserCloseIntents: vi.fn(),
        closeBrowserTab,
        closeBrowserPage,
        requestPinnedTabCloseConfirm,
        browserPagesByWorkspace: {
          'workspace-1': [{ id: 'page-1', workspaceId: 'workspace-1' }]
        },
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'browser-unified-1',
              entityId: 'workspace-1',
              contentType: 'browser',
              label: 'Docs',
              isPinned: true
            }
          ]
        }
      })
    })

    requestTabCloseListenerRef.current?.({ requestId: 'req-page', tabId: 'page-1' })

    expect(closeBrowserPage).not.toHaveBeenCalled()
    expect(closeBrowserTab).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ tabLabel: 'Docs', onConfirm: expect.any(Function) })
    )
  })

  it('refuses to close a browser page outside the requested worktree', async () => {
    const requestTabCloseListenerRef: { current: RequestTabCloseListener | null } = {
      current: null
    }
    const closeBrowserTab = vi.fn()
    const closeBrowserPage = vi.fn()
    const replyTabClose = vi.fn()

    await useIpcEventsForCloseRouting({
      requestTabCloseListenerRef,
      replyTabClose,
      getState: () => ({
        recordClientHostedBrowserCloseIntents: vi.fn(),
        closeBrowserTab,
        closeBrowserPage,
        browserTabsByWorktree: {
          'wt-1': [{ id: 'workspace-1' }],
          'wt-2': [{ id: 'workspace-2' }]
        },
        browserPagesByWorkspace: {
          'workspace-1': [{ id: 'page-1', workspaceId: 'workspace-1' }],
          'workspace-2': [{ id: 'page-2', workspaceId: 'workspace-2' }]
        }
      })
    })

    requestTabCloseListenerRef.current?.({
      requestId: 'req-wrong-worktree',
      tabId: 'page-2',
      worktreeId: 'wt-1'
    })

    expect(closeBrowserPage).not.toHaveBeenCalled()
    expect(closeBrowserTab).not.toHaveBeenCalled()
    expect(replyTabClose).toHaveBeenCalledWith({
      requestId: 'req-wrong-worktree',
      code: 'browser_tab_not_found',
      error: 'Browser tab page-2 not found'
    })
  })
})
