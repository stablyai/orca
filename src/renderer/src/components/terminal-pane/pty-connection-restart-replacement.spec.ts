import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  leafIdForPane,
  createMockTransport,
  createPane,
  createManager
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

export function registerPtyConnectionRestartReplacementTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  describe('connectPanePty', () => {
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
    /** A pane running an agent, with the live recovery record the app keeps for every agent turn. */
    async function connectWithAgent(opts: { visible: boolean; turnDone?: boolean }) {
      const { connectPanePty } = await import('./pty-connection')
      const { deliverPtyExitToHandlers } = await import('./pty-exit-delivery')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const deps = createDeps({ isVisibleRef: { current: opts.visible } })
      const pane = createPane(2)
      const paneKey = `tab-1:${leafIdForPane(2)}`
      mockStoreState.removeAgentStatus.mockImplementation((key: string) => {
        delete mockStoreState.agentStatusByPaneKey[key]
      })
      mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
        paneKey,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'sess-1' },
        prompt: 'fix it',
        state: opts.turnDone ? 'done' : 'working',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'live'
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures implement the pane, manager and deps members connectPanePty reads.
      const args = [pane, createManager(1), deps] as unknown as Parameters<typeof connectPanePty>
      const binding = connectPanePty(...args)
      await flushAsyncTicks()
      const onPtyExit = createdTransportOptions[0]?.onPtyExit
      if (typeof onPtyExit !== 'function') {
        throw new Error('expected the transport exit handler')
      }
      const exit = async (replacedByRestart: boolean): Promise<void> => {
        deliverPtyExitToHandlers({
          ptyId: 'tab-pty',
          code: -1,
          replacedByRestart,
          primary: (code) => onPtyExit('tab-pty', code),
          sidecars: []
        })
        await flushAsyncTicks()
      }
      const connects = (): number => transport.connect.mock.calls.length
      const lastCommand = (): string | undefined =>
        transport.connect.mock.calls.at(-1)?.[0]?.command
      return { binding, exit, connects, lastCommand }
    }

    it('resumes a restart-replaced hidden pane once, when it is next shown', async () => {
      const pane = await connectWithAgent({ visible: false })
      const before = pane.connects()

      await pane.exit(true)
      expect(pane.connects()).toBe(before)

      pane.binding.noteVisibilityResume()
      await flushAsyncTicks()
      expect(pane.connects()).toBe(before + 1)
      expect(pane.lastCommand()).toContain('sess-1')

      pane.binding.noteVisibilityResume()
      await flushAsyncTicks()
      expect(pane.connects()).toBe(before + 1)
    })

    it('resumes a restart-replaced pane at once when it is visible', async () => {
      const pane = await connectWithAgent({ visible: true })
      const before = pane.connects()

      await pane.exit(true)

      expect(pane.connects()).toBe(before + 1)
      expect(pane.lastCommand()).toContain('sess-1')
    })

    it('spawns nothing for a restart-replaced pane closed before it is shown', async () => {
      const pane = await connectWithAgent({ visible: false })
      await pane.exit(true)
      const before = pane.connects()

      pane.binding.dispose()
      pane.binding.noteVisibilityResume()
      await flushAsyncTicks()

      expect(pane.connects()).toBe(before)
    })

    it('spawns nothing when another flow rebound the pane before it is shown', async () => {
      const pane = await connectWithAgent({ visible: false })
      await pane.exit(true)
      const before = pane.connects()
      mockStoreState.terminalLayoutsByTabId = {
        ...mockStoreState.terminalLayoutsByTabId,
        'tab-1': {
          root: { type: 'leaf', leafId: leafIdForPane(2) },
          activeLeafId: leafIdForPane(2),
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafIdForPane(2)]: 'pty-replacement' }
        }
      }

      pane.binding.noteVisibilityResume()
      await flushAsyncTicks()

      expect(pane.connects()).toBe(before)
    })

    it('resumes an agent whose turn had finished the same way, once, when shown', async () => {
      const pane = await connectWithAgent({ visible: false, turnDone: true })
      const before = pane.connects()
      await pane.exit(true)
      expect(pane.connects()).toBe(before)

      pane.binding.noteVisibilityResume()
      await flushAsyncTicks()
      pane.binding.noteVisibilityResume()
      await flushAsyncTicks()

      expect(pane.connects()).toBe(before + 1)
      expect(pane.lastCommand()).toContain('sess-1')
    })

    it('leaves a pane lost to any other -1 exit without a process', async () => {
      const pane = await connectWithAgent({ visible: false })
      const before = pane.connects()
      await pane.exit(false)

      pane.binding.noteVisibilityResume()
      await flushAsyncTicks()

      expect(pane.connects()).toBe(before)
    })
  })
}
