import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import { expectMainFrameClosesExitedSplitPaneOnce } from '../test-fixtures/pty-connection-test-exited-split-pane-close'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LEAF_2,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from '../test-fixtures/pty-connection-test-deps'
import { createInitialStoreState } from '../test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'

export function registerPtyConnectionSetupAutoCloseTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  describe('connectPanePty', () => {
    beforeEach(async () => {
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

    it('closes a fresh sole setup terminal whose shell exited because setup succeeded', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      for (const [command, exitCode, closes] of [
        ['bash /repo/.git/orca/setup-runner.sh && exit 79', 79, true],
        ['cmd.exe /c "C:\\r\\setup-runner.cmd"; if ($LASTEXITCODE -eq 0) { exit 79 }', 79, true],
        ['bash /repo/.git/orca/setup-runner.sh', 79, false],
        // A shell that quits before setup is delivered (rc file runs `exit`) stays open.
        ['bash /repo/.git/orca/setup-runner.sh && exit 79', 0, false],
        // A failed setup keeps its pane open so the error stays readable.
        ['bash /repo/.git/orca/setup-runner.sh && exit 79', 1, false],
        ['cmd.exe /c "C:\\r\\setup-runner.cmd"; if ($LASTEXITCODE -eq 0) { exit 79 }', 1, false]
      ] as const) {
        transportFactoryQueue.push(createMockTransport('tab-pty'))
        createdTransportOptions = []
        const deps = createDeps({ startup: { command } })

        connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
        const { onPtySpawn, onPtyExit } = createdTransportOptions[0] ?? {}
        if (typeof onPtySpawn !== 'function' || typeof onPtyExit !== 'function') {
          throw new Error('transport callbacks were not captured')
        }
        onPtySpawn('tab-pty')
        onPtyExit('tab-pty', exitCode)

        if (closes) {
          expect(deps.onPtyExitRef.current).toHaveBeenCalledWith('tab-pty', 79)
        } else {
          expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
        }
      }
    })

    it('closes a visible newborn setup split whose shell exited because setup succeeded', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      transportFactoryQueue.push(createMockTransport('pty-pane-2'))
      const manager = createManager(2, 2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        startup: { command: 'bash /repo/.git/orca/setup-runner.sh && exit 79' },
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      connectPanePty(createPane(2) as never, manager as never, deps as never)
      const { onPtyExit } = createdTransportOptions[0] ?? {}
      if (typeof onPtyExit !== 'function') {
        throw new Error('transport callbacks were not captured')
      }

      onPtyExit('pty-pane-2', 79)

      expect(manager.setActivePane).not.toHaveBeenCalledWith(1, { focus: true })
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await expectMainFrameClosesExitedSplitPaneOnce(manager)
      } else {
        expect(manager.closePane).toHaveBeenCalledWith(2)
      }
    })
  })
}
