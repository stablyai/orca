import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useIpcEventsForCloseRouting,
  type SessionTabCloseRequestListener
} from './ipc-events-close-routing-test-harness'

describe('useIpcEvents session tab close requests', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('acknowledges a close after the store removes the tab', async () => {
    const listenerRef: { current: SessionTabCloseRequestListener | null } = { current: null }
    const closeUnifiedTab = vi.fn().mockReturnValue({ id: 'sim-tab-1' })
    const respondSessionTabClose = vi.fn()

    await useIpcEventsForCloseRouting({
      sessionTabCloseRequestListenerRef: listenerRef,
      respondSessionTabClose,
      getState: () => ({
        closeUnifiedTab,
        browserTabsByWorktree: {},
        openFiles: [],
        unifiedTabsByWorktree: {
          'wt-1': [
            { id: 'sim-tab-1', entityId: 'sim-1', contentType: 'simulator', isPinned: false }
          ]
        }
      })
    })

    listenerRef.current?.({
      requestId: 'close-session-tab',
      tabId: 'sim-tab-1',
      worktreeId: 'wt-1'
    })

    expect(closeUnifiedTab).toHaveBeenCalledWith('sim-tab-1')
    expect(respondSessionTabClose).toHaveBeenCalledWith({ requestId: 'close-session-tab' })
  })

  it('rejects a pinned browser close when confirmation is canceled', async () => {
    const listenerRef: { current: SessionTabCloseRequestListener | null } = { current: null }
    const closeBrowserTab = vi.fn()
    const respondSessionTabClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()

    await useIpcEventsForCloseRouting({
      sessionTabCloseRequestListenerRef: listenerRef,
      respondSessionTabClose,
      getState: () => ({
        closeBrowserTab,
        requestPinnedTabCloseConfirm,
        browserTabsByWorktree: { 'wt-1': [{ id: 'workspace-1' }] },
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

    listenerRef.current?.({
      requestId: 'close-pinned-session-tab',
      tabId: 'workspace-1',
      worktreeId: 'wt-1'
    })
    const request = requestPinnedTabCloseConfirm.mock.calls[0][0] as { onCancel: () => void }
    request.onCancel()

    expect(closeBrowserTab).not.toHaveBeenCalled()
    expect(respondSessionTabClose).toHaveBeenCalledWith({
      requestId: 'close-pinned-session-tab',
      error: 'session_tab_close_canceled'
    })
  })

  it('expires a pending pinned close without allowing late confirmation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const listenerRef: { current: SessionTabCloseRequestListener | null } = { current: null }
    const closeBrowserTab = vi.fn()
    const respondSessionTabClose = vi.fn()
    const requestPinnedTabCloseConfirm = vi.fn()
    const cancelPinnedTabCloseRequest = vi.fn()

    await useIpcEventsForCloseRouting({
      sessionTabCloseRequestListenerRef: listenerRef,
      respondSessionTabClose,
      getState: () => ({
        closeBrowserTab,
        requestPinnedTabCloseConfirm,
        cancelPinnedTabCloseRequest,
        browserTabsByWorktree: { 'wt-1': [{ id: 'workspace-1' }] },
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

    listenerRef.current?.({
      requestId: 'expiring-close',
      tabId: 'workspace-1',
      worktreeId: 'wt-1',
      expiresAt: 2_000
    })
    const request = requestPinnedTabCloseConfirm.mock.calls[0][0] as { onConfirm: () => void }
    vi.advanceTimersByTime(1_000)

    expect(cancelPinnedTabCloseRequest).toHaveBeenCalledWith(request)
    expect(respondSessionTabClose).toHaveBeenCalledWith({
      requestId: 'expiring-close',
      error: 'session_tab_close_timeout'
    })
    request.onConfirm()
    expect(closeBrowserTab).not.toHaveBeenCalled()
    expect(respondSessionTabClose).toHaveBeenCalledTimes(1)
  })
})
