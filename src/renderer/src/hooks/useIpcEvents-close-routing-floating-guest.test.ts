import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FLOATING_WORKSPACE_GUEST_CLOSE_EVENT,
  FLOATING_WORKSPACE_GUEST_SELECT_INDEX_EVENT
} from '@/lib/floating-workspace-guest-bridge'
import {
  useIpcEventsForCloseRouting,
  type CloseFloatingItemListener,
  type SelectFloatingIndexListener
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
    // Clear leaked partial mocks so floating browser source validation uses the real resolver.
    vi.doUnmock('@/lib/floating-workspace-terminal-actions')
    closeTerminalTabMock.mockReset()
  })

  // Validate a live floating browser source before redispatching the mounted panel’s typed close event.
  function dispatchedEventTypes(): string[] {
    const dispatchEvent = (window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls
    return dispatchEvent.map((call) => (call[0] as Event).type)
  }

  // Main forwards the guest's page id, so the receiver must resolve it to the owning workspace id.
  it('re-dispatches a floating-guest close for a live floating browser page source', async () => {
    const closeFloatingItemListenerRef: { current: CloseFloatingItemListener | null } = {
      current: null
    }

    await useIpcEventsForCloseRouting({
      closeFloatingItemListenerRef,
      getState: () => ({
        browserTabsByWorktree: { 'global-floating-terminal': [{ id: 'workspace-1' }] },
        browserPagesByWorkspace: { 'workspace-1': [{ id: 'page-1' }] }
      })
    })

    closeFloatingItemListenerRef.current?.({ sourceId: 'page-1' })

    const closeEvents = (window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as CustomEvent)
      .filter((event) => event.type === FLOATING_WORKSPACE_GUEST_CLOSE_EVENT)
    expect(closeEvents).toHaveLength(1)
    expect(closeEvents[0].detail).toEqual({ sourceId: 'workspace-1' })
  })

  it('re-dispatches a floating-guest close for a live floating browser workspace source', async () => {
    const closeFloatingItemListenerRef: { current: CloseFloatingItemListener | null } = {
      current: null
    }

    await useIpcEventsForCloseRouting({
      closeFloatingItemListenerRef,
      getState: () => ({
        browserTabsByWorktree: { 'global-floating-terminal': [{ id: 'workspace-1' }] },
        browserPagesByWorkspace: { 'workspace-1': [{ id: 'page-1' }] }
      })
    })

    closeFloatingItemListenerRef.current?.({ sourceId: 'workspace-1' })

    const closeEvents = (window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as CustomEvent)
      .filter((event) => event.type === FLOATING_WORKSPACE_GUEST_CLOSE_EVENT)
    expect(closeEvents).toHaveLength(1)
    expect(closeEvents[0].detail).toEqual({ sourceId: 'workspace-1' })
  })

  it('ignores a floating-guest close for a stale/unknown source (no-op)', async () => {
    const closeFloatingItemListenerRef: { current: CloseFloatingItemListener | null } = {
      current: null
    }

    await useIpcEventsForCloseRouting({
      closeFloatingItemListenerRef,
      getState: () => ({
        browserTabsByWorktree: { 'global-floating-terminal': [{ id: 'workspace-1' }] },
        browserPagesByWorkspace: { 'workspace-1': [{ id: 'page-1' }] }
      })
    })

    closeFloatingItemListenerRef.current?.({ sourceId: 'already-closed' })

    expect(dispatchedEventTypes()).not.toContain(FLOATING_WORKSPACE_GUEST_CLOSE_EVENT)
  })

  it('re-dispatches a floating-guest index select', async () => {
    const selectFloatingIndexListenerRef: { current: SelectFloatingIndexListener | null } = {
      current: null
    }

    await useIpcEventsForCloseRouting({
      selectFloatingIndexListenerRef,
      getState: () => ({})
    })

    selectFloatingIndexListenerRef.current?.({ index: 2 })

    const selectEvents = (window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as CustomEvent)
      .filter((event) => event.type === FLOATING_WORKSPACE_GUEST_SELECT_INDEX_EVENT)
    expect(selectEvents).toHaveLength(1)
    expect(selectEvents[0].detail).toEqual({ index: 2 })
  })
})
