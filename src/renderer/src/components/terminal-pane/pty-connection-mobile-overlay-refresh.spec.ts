import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'

const PTY_ID = 'pty-overlay-refresh'

export function registerPtyConnectionMobileOverlayRefreshTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  async function connectPaneWithOverlayRefresh(): Promise<ReturnType<typeof vi.fn>> {
    const { connectPanePty } = await import('./pty-connection')
    transportFactoryQueue.push(createMockTransport(PTY_ID))
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] }
    }
    const refreshMobileOverlays = vi.fn()
    const deps = buildPaneConnectionDeps(() => mockStoreState, { refreshMobileOverlays })
    connectPanePty(...mockPanePtyArgs(createPane(1), createManager(1), deps))
    await flushAsyncTicks()
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn
    if (typeof onPtySpawn !== 'function') {
      throw new Error('Transport did not register its spawn callback')
    }
    onPtySpawn(PTY_ID)
    // Guard the premise: the pane actually bound the PTY.
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', PTY_ID)
    return refreshMobileOverlays
  }

  describe('connectPanePty mobile overlay refresh', () => {
    beforeEach(async () => {
      vi.resetModules()
      vi.clearAllMocks()
      transportFactoryQueue = []
      createdTransportOptions = []
      storeSubscribers = []
      mockStoreState = createInitialStoreState(() => mockStoreState)
      bindPtyConnectionTestMocks({
        getState: () => mockStoreState,
        getTransportQueue: () => transportFactoryQueue,
        getTransportOptions: () => createdTransportOptions,
        getStoreSubscribers: () => storeSubscribers,
        setStoreSubscribers: (subscribers) => {
          storeSubscribers = subscribers
        }
      })
      await installTerminalTestGlobals()
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    // Why: hydration can land before the pane binds its PTY, when the overlay tick has no pane to re-render.
    it('re-renders the overlay when a pane binds a PTY already held at phone fit', async () => {
      const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
      setFitOverride(PTY_ID, 'mobile-fit', 40, 30)
      try {
        const refreshMobileOverlays = await connectPaneWithOverlayRefresh()
        expect(refreshMobileOverlays).toHaveBeenCalled()
      } finally {
        setFitOverride(PTY_ID, 'desktop-fit', 0, 0)
      }
    })

    it('re-renders the overlay when a pane binds a PTY the phone already drives', async () => {
      const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')
      setDriverForPty(PTY_ID, { kind: 'mobile', clientId: 'phone-1' })
      try {
        const refreshMobileOverlays = await connectPaneWithOverlayRefresh()
        expect(refreshMobileOverlays).toHaveBeenCalled()
      } finally {
        setDriverForPty(PTY_ID, { kind: 'idle' })
      }
    })

    it('leaves the overlay alone when the bound PTY has no phone state', async () => {
      const refreshMobileOverlays = await connectPaneWithOverlayRefresh()
      expect(refreshMobileOverlays).not.toHaveBeenCalled()
    })
  })
}
