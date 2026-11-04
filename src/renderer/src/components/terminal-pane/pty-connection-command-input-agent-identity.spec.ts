import { expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import { sendTerminalInputThroughPane } from './pty-connection-test-dom'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import {
  resolveMockPaneWindowsShiftEnterEncoding,
  type StoreState
} from './pty-connection-test-store-state'
import {
  type PtyConnectionAgentTitleMocks,
  type PaneConnectionDeps,
  bindPaneAgentTitleMocks
} from './pty-connection-test-deps'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'

type CommandInputAgentIdentityFixture = {
  readonly storeState: StoreState
  readonly transportQueue: MockTransport[]
  readonly createDeps: (overrides?: Record<string, unknown>) => PaneConnectionDeps
}

export function registerPtyConnectionCommandInputAgentIdentityTests(
  fixture: CommandInputAgentIdentityFixture
): void {
  it.each(['process', 'launch'] as const)(
    'does not let typed Droid input replace another live TUI %s identity',
    async (identitySource) => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      const agentTitleMocks =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const pane = createPane(1)
      const ptyId = `pty-antigravity-${identitySource}-typed-droid`
      const tabId = `tab-antigravity-${identitySource}-typed-droid`
      const paneKey = makePaneKey(tabId, LEAF_1)
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks.onData ?? null
          return { id: ptyId }
        }
      )
      fixture.transportQueue.push(transport)

      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          bindPaneAgentTitleMocks(
            fixture.createDeps({ tabId, isVisibleRef: { current: false } }),
            agentTitleMocks
          )
        )
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()
      if (identitySource === 'process') {
        fixture.storeState.paneForegroundAgentByPaneKey[paneKey] = {
          agent: 'antigravity',
          shellForeground: false
        }
      } else {
        fixture.storeState.agentLaunchConfigByPaneKey[paneKey] = {
          launchConfig: { agentArgs: '', agentEnv: {} },
          identity: { agentType: 'antigravity' }
        }
      }

      sendTerminalInputThroughPane(pane, 'droid\r')
      dataCallbackRef.current?.('\x1b]133;C\x07')

      expect(fixture.storeState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
        agent: null,
        shellForeground: false
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(fixture.storeState, paneKey)).toBe(
        'alt-enter'
      )
    }
  )

  it.each([
    ['SSH', 'ssh:conn@@pty-typed-droid', 'tab-ssh-typed-droid'],
    ['remote runtime', 'remote:web-env-1@@pty-typed-droid', 'tab-remote-typed-droid']
  ])(
    'does not persist typed command process evidence for %s panes',
    async (_label, ptyId, tabId) => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      const agentTitleMocks2 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const pane = createPane(1)
      const paneKey = makePaneKey(tabId, LEAF_1)
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks.onData ?? null
          return { id: ptyId }
        }
      )
      fixture.transportQueue.push(transport)

      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          bindPaneAgentTitleMocks(
            fixture.createDeps({ tabId, isVisibleRef: { current: false } }),
            agentTitleMocks2
          )
        )
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()

      sendTerminalInputThroughPane(pane, 'droid\r')
      dataCallbackRef.current?.('\x1b]133;C\x07\x1b]133;D;0\x07')

      expect(fixture.storeState.paneForegroundAgentByPaneKey[paneKey]).toBeUndefined()
      expect(fixture.storeState.setPaneForegroundAgent).not.toHaveBeenCalledWith(
        paneKey,
        expect.anything()
      )
    }
  )
}
