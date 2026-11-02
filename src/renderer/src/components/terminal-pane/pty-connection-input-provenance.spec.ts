import { expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import { createKeyboardEventTarget, keyEvent } from './pty-connection-test-dom'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'
import type { AgentPaneConversationIdentity } from '@/store/slices/agent-pane-conversation'
import type { ITerminalOptions } from '@xterm/headless'

type InputProvenanceFixture = {
  getState: () => StoreState
  getTransportQueue: () => MockTransport[]
  createDeps: () => ReturnType<typeof buildPaneConnectionDeps>
}

export function registerPtyConnectionInputProvenanceTests({
  getState,
  getTransportQueue,
  createDeps
}: InputProvenanceFixture): void {
  it.each(['query during read', 'query during interrupt', 'driving after D'] as const)(
    'keeps causal input provenance through deferred D settlement: %s',
    async (scenario) => {
      vi.useFakeTimers()
      const mockStoreState = getState()
      const { Terminal } = await import('@xterm/headless')
      const { connectPanePty } = await import('./pty-connection')
      const { createTestStore, makeTab } = await import('@/store/slices/store-test-helpers')
      const statusStore = createTestStore()
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const ptyId = 'pty-query-d-fence'
      const pane = createPane(1)
      const terminalOptions: ITerminalOptions & { termName: string } = { termName: 'linux' }
      const terminal = new Terminal(terminalOptions)
      Object.assign(pane.terminal, {
        _core: Reflect.get(terminal, '_core'),
        onData: vi.fn((listener: (data: string) => void) => terminal.onData(listener))
      })
      pane.terminal.write.mockImplementation((data, callback) => terminal.write(data, callback))
      const output: { current?: (data: string) => void } = {}
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(async ({ callbacks }) => {
        output.current = callbacks.onData
        return { id: ptyId }
      })
      getTransportQueue().push(transport)
      const target = createKeyboardEventTarget()
      pane.terminal.element = target.target
      const connection = connectPanePty(...mockPanePtyArgs(pane, createManager(1), createDeps()))
      try {
        await vi.advanceTimersByTimeAsync(1000)
        statusStore.getState().setAgentStatus(paneKey, {
          state: scenario === 'query during interrupt' ? 'working' : 'done',
          agentType: 'claude',
          prompt: 'finish this turn'
        })
        const original = statusStore.getState().agentStatusByPaneKey[paneKey]!
        statusStore.getState().retainAgents([
          {
            entry: original,
            worktreeId: 'wt-1',
            tab: makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId }),
            agentType: 'claude',
            startedAt: original.stateStartedAt
          }
        ])
        const syncStatus = () => {
          mockStoreState.agentStatusByPaneKey = statusStore.getState().agentStatusByPaneKey
          mockStoreState.retainedAgentsByPaneKey = statusStore.getState().retainedAgentsByPaneKey
        }
        syncStatus()
        mockStoreState.dropAgentStatus.mockImplementation((key: string) => {
          statusStore.getState().dropAgentStatus(key)
          syncStatus()
        })
        const recovery: AgentPaneConversationIdentity = {
          paneKey,
          worktreeId: 'wt-1',
          executionHostId: 'local',
          connectionId: null,
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'resumable-turn' }
        }
        statusStore.setState({
          agentConversationsByPaneKey: { [paneKey]: recovery }
        })
        const read = createDeferred<string>()
        const inference = createDeferred<boolean>()
        vi.mocked(window.api.pty.confirmForegroundProcess).mockImplementation(() => read.promise)
        vi.mocked(window.api.agentStatus.inferInterrupt).mockImplementation(() => inference.promise)
        if (scenario === 'query during interrupt') {
          target.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
          terminal.input('\x03', true)
          await flushAsyncTicks()
        } else {
          terminal.input('prompt\r/exit\r', true)
        }
        output.current?.('\x1b]133;D;0\x07\x1b]133;A\x07')
        await vi.advanceTimersByTimeAsync(350)
        expect(window.api.pty.confirmForegroundProcess).toHaveBeenCalledWith(ptyId)
        expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
        if (scenario === 'query during interrupt') {
          read.resolve('zsh')
          await vi.advanceTimersByTimeAsync(350)
          expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalledOnce()
          expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
        }
        const { getTerminalSemanticResident } = await import('./terminal-semantic-residents')
        const resident = getTerminalSemanticResident(ptyId)
        if (!resident) {
          throw new Error('Expected the forwarded input execution')
        }
        const shellInput = vi.spyOn(resident.policy.shellInput, 'observeAcceptedShellCommandInput')
        // xterm's Linux-console DA2 reply is printable, so only provenance can distinguish it.
        output.current?.('\x1b[>c')
        await vi.advanceTimersByTimeAsync(20)
        expect(transport.sendInput).toHaveBeenCalledWith(
          '0c',
          'query-reply',
          expect.objectContaining({ onEligible: expect.any(Function) })
        )
        if (scenario === 'driving after D') {
          terminal.input('next command\r', true)
        }
        if (scenario !== 'query during interrupt') {
          read.resolve('zsh')
        }
        await vi.advanceTimersByTimeAsync(350)
        if (scenario === 'query during interrupt') {
          expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalledOnce()
          expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
          inference.resolve(false)
        }
        await vi.advanceTimersByTimeAsync(1200 + 6000)
        if (scenario === 'driving after D') {
          expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
          expect(statusStore.getState().agentStatusByPaneKey[paneKey]).toBe(original)
          output.current?.('\x1b]133;C\x07next\x1b]133;D;0\x07\x1b]133;A\x07')
          await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
        }
        expect(mockStoreState.dropAgentStatus).toHaveBeenCalledExactlyOnceWith(paneKey)
        expect(statusStore.getState().agentStatusByPaneKey[paneKey]).toBeUndefined()
        expect(statusStore.getState().retainedAgentsByPaneKey[paneKey]).toBeUndefined()
        expect(statusStore.getState().agentConversationsByPaneKey[paneKey]).toEqual(recovery)
        expect(shellInput).not.toHaveBeenCalledWith('0c')
      } finally {
        connection.dispose()
        terminal.dispose()
      }
    }
  )
}
