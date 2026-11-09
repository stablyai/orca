import { expect, it, vi } from 'vitest'
import { flushAsyncTicks, createDeferred } from '../test-fixtures/pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  type PtyConnectionAgentTitleMocks as AgentTitleMocks,
  bindPaneAgentTitleMocks,
  type buildPaneConnectionDeps
} from '../test-fixtures/pty-connection-test-deps'

export function registerStaleDaemonSnapshotReplayTests(
  getContext: () => {
    transportFactoryQueue: MockTransport[]
    createDeps: (overrides?: Record<string, unknown>) => ReturnType<typeof buildPaneConnectionDeps>
  }
): void {
  it('drops stale callbacks but delivers fresh replacement output after an old replay clear', async () => {
    const { transportFactoryQueue, createDeps } = getContext()
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks15 = await vi.importMock<AgentTitleMocks>(
      '@/lib/agent-status/aggregation/worktree-agent-status'
    )
    const { getTerminalScrollIntentKind, markTerminalPinnedViewport } =
      await import('@/lib/pane-manager/terminal-scroll-intent')
    const transport = createMockTransport('tab-pty')
    const oldResult = createDeferred<undefined>()
    const oldCallbacks: { current: ConnectCallbacks | null } = { current: null }
    const replacementCallbacks: { current: ConnectCallbacks | null } = { current: null }
    let connectCount = 0
    transport.connect.mockImplementation(
      async ({ callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        connectCount += 1
        if (connectCount === 1) {
          oldCallbacks.current = callbacks ?? null
          return oldResult.promise
        }
        vi.mocked(transport.getPtyId).mockReturnValue('replacement-pty')
        replacementCallbacks.current = callbacks ?? null
        return 'replacement-pty'
      }
    )
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    pane.terminal.buffer.active.viewportY = 80
    pane.terminal.buffer.active.baseY = 100
    markTerminalPinnedViewport(pane.terminal)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(
      pane as never,
      createManager(1) as never,
      bindPaneAgentTitleMocks(deps as never, agentTitleMocks15)
    )
    await flushAsyncTicks(8)
    oldCallbacks.current?.onReplayData?.('old replay')
    await flushAsyncTicks(8)
    parseCallbacks.shift()?.()
    await flushAsyncTicks(8)
    oldCallbacks.current?.onError?.('SSH_SESSION_EXPIRED: tab-pty')
    oldResult.resolve(undefined)
    await flushAsyncTicks(20)
    expect(replacementCallbacks.current).not.toBeNull()

    replacementCallbacks.current?.onData?.('B-PROMPT')
    oldCallbacks.current?.onData?.('STALE-A')
    while (parseCallbacks.length > 0) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(4)
    }
    await flushAsyncTicks(20)

    expect(writes).toContain('B-PROMPT')
    expect(writes).not.toContain('STALE-A')
    expect(pane.terminal.scrollToBottom).toHaveBeenCalled()
    expect(getTerminalScrollIntentKind(pane.terminal)).toBe('followOutput')
  })
}
