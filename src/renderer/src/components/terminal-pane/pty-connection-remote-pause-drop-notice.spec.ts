import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

// Why: switching back to a remote pane cost a 5000-row snapshot even when the host dropped nothing (#24863).
export function registerPtyConnectionRemotePauseDropNoticeTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  describe('connectPanePty remote pause drop notice', () => {
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

    async function connectRemotePane(dropsReported: boolean) {
      const { connectPanePty } = await import('./pty-connection')
      const remotePtyId = 'remote:env-1@@terminal-1'
      const transport = createMockTransport(remotePtyId)
      const callbacks: { current: ConnectCallbacks } = { current: {} }
      transport.connect.mockImplementation(async (options: { callbacks?: ConnectCallbacks }) => {
        callbacks.current = options.callbacks ?? {}
        return remotePtyId
      })
      transport.setOutputPaused = vi.fn((paused: boolean) => {
        callbacks.current.onOutputPauseChanged?.(paused, true, dropsReported)
        return true
      })
      transport.serializeBuffer = vi.fn().mockResolvedValue({
        data: 'host snapshot\r\n',
        cols: 100,
        rows: 30,
        seq: 10,
        source: 'headless'
      })
      transportFactoryQueue.push(transport)
      mockStoreState.repos = [
        { id: 'repo1', connectionId: null, displayName: 'orca', executionHostId: 'runtime:env-1' }
      ]
      mockStoreState.worktreesByRepo.repo1[0].runtimeOwnerEnvironmentId = 'env-1'
      const pane = createPane(1)
      const deps = buildPaneConnectionDeps(() => mockStoreState, {
        isVisibleRef: { current: true }
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures model the pane, manager and deps surface connectPanePty reads.
      const binding = connectPanePty(pane as never, createManager(1) as never, deps as never)
      await flushAsyncTicks(6)
      const setVisible = async (visible: boolean): Promise<void> => {
        deps.isVisibleRef.current = visible
        binding.syncProcessTracking()
        await flushAsyncTicks(20)
      }
      const written = (): string =>
        pane.terminal.write.mock.calls.map((call) => String(call[0])).join('')
      return { transport, callbacks, binding, setVisible, written }
    }

    it('switches back to a quiet paused pane without fetching a snapshot', async () => {
      const { transport, callbacks, binding, setVisible, written } = await connectRemotePane(true)

      for (let switchIndex = 0; switchIndex < 3; switchIndex += 1) {
        await setVisible(false)
        expect(transport.setOutputPaused).toHaveBeenLastCalledWith(true)
        await setVisible(true)
        expect(transport.setOutputPaused).toHaveBeenLastCalledWith(false)
      }
      const live = 'live after reveal\r\n'
      callbacks.current.onData?.(live, { seq: 10 + live.length, rawLength: live.length })
      await flushAsyncTicks(20)

      expect(transport.serializeBuffer).not.toHaveBeenCalled()
      expect(written()).toContain(live)
      binding.dispose()
    })

    it('restores exactly once when the host reports a paused drop', async () => {
      const { transport, callbacks, binding, setVisible, written } = await connectRemotePane(true)

      await setVisible(false)
      callbacks.current.onPausedOutputDropped?.()
      await flushAsyncTicks(6)
      expect(transport.serializeBuffer).not.toHaveBeenCalled()
      await setVisible(true)
      const live = 'live after restore\r\n'
      callbacks.current.onData?.(live, { seq: 10 + live.length, rawLength: live.length })
      await flushAsyncTicks(20)

      expect(transport.serializeBuffer).toHaveBeenCalledTimes(1)
      const text = written()
      expect(text.split('host snapshot').length - 1).toBe(1)
      expect(text.split(live).length - 1).toBe(1)

      // The next quiet switch is free again.
      await setVisible(false)
      await setVisible(true)
      expect(transport.serializeBuffer).toHaveBeenCalledTimes(1)
      binding.dispose()
    })

    it('still restores on every reveal when the host cannot report drops', async () => {
      const { transport, binding, setVisible } = await connectRemotePane(false)

      await setVisible(false)
      await setVisible(true)

      expect(transport.serializeBuffer).toHaveBeenCalledTimes(1)
      binding.dispose()
    })
  })
}
