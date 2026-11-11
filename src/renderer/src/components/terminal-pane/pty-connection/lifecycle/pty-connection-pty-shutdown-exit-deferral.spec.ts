import { expect, it, vi } from 'vitest'
import {
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  type PtyConnectionAgentTitleMocks,
  type PaneConnectionDeps,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'

type PtyShutdownExitDeferralFixture = {
  readonly transportQueue: MockTransport[]
  readonly transportOptions: Record<string, unknown>[]
  readonly createDeps: (overrides?: Record<string, unknown>) => PaneConnectionDeps
}

export function registerPtyConnectionShutdownExitDeferralTests(
  fixture: PtyShutdownExitDeferralFixture
): void {
  it('keeps the surviving split pane mounted when an intentional pane-close PTY exit arrives', async () => {
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
      '@/lib/agent-status/aggregation/worktree-agent-status'
    )
    const transport = createMockTransport('pty-pane-2')
    fixture.transportQueue.push(transport)
    const manager = createManager(1)
    const deps = fixture.createDeps({
      consumeSuppressedPtyExit: vi.fn(() => true)
    })

    connectPanePty(
      createPane(2) as never,
      manager as never,
      bindPaneAgentTitleMocks(deps as never, agentTitleMocks)
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock factory records connectPanePty's typed exit callback.
    const onPtyExit = fixture.transportOptions[0]?.onPtyExit as
      | ((ptyId: string, exitCode?: number) => void)
      | undefined
    expect(onPtyExit).toBeTypeOf('function')

    onPtyExit?.('pty-pane-2')

    expect(deps.consumeSuppressedPtyExit).toHaveBeenCalledWith('pty-pane-2')
    expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(2, null)
    expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-pane-2')
    expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('defers all exit-side state mutation while worktree shutdown verification is pending', async () => {
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks2 = await vi.importMock<PtyConnectionAgentTitleMocks>(
      '@/lib/agent-status/aggregation/worktree-agent-status'
    )
    const { settleDeferredPtyShutdownExits } =
      await import('../../pty-transport/shutdown/pty-shutdown-exit-deferral')
    const transport = createMockTransport('pty-pane-2')
    fixture.transportQueue.push(transport)
    const manager = createManager(1)
    let pending = true
    const deps = fixture.createDeps({
      isPtyShutdownPending: vi.fn(() => pending),
      consumeSuppressedPtyExit: vi.fn(() => true)
    })

    connectPanePty(
      createPane(2) as never,
      manager as never,
      bindPaneAgentTitleMocks(deps as never, agentTitleMocks2)
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock factory records connectPanePty's typed exit callback.
    const onPtyExit = fixture.transportOptions[0]?.onPtyExit as
      | ((ptyId: string) => void)
      | undefined

    onPtyExit?.('pty-pane-2')

    expect(deps.consumeSuppressedPtyExit).not.toHaveBeenCalled()
    expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(deps.clearRuntimePaneTitle).not.toHaveBeenCalled()
    expect(deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()

    pending = false
    settleDeferredPtyShutdownExits(['pty-pane-2'], 'committed')
    expect(deps.consumeSuppressedPtyExit).toHaveBeenCalledWith('pty-pane-2')
    expect(deps.clearRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 2)
    expect(deps.clearTabPtyId).not.toHaveBeenCalled()
  })

  it('keeps renderer state intact for an exit deferred through rollback', async () => {
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks3 = await vi.importMock<PtyConnectionAgentTitleMocks>(
      '@/lib/agent-status/aggregation/worktree-agent-status'
    )
    const { settleDeferredPtyShutdownExits } =
      await import('../../pty-transport/shutdown/pty-shutdown-exit-deferral')
    const transport = createMockTransport('pty-pane-2')
    fixture.transportQueue.push(transport)
    const manager = createManager(1)
    let pending = true
    const deps = fixture.createDeps({
      isPtyShutdownPending: vi.fn(() => pending),
      consumeSuppressedPtyExit: vi.fn(() => true)
    })

    connectPanePty(
      createPane(2) as never,
      manager as never,
      bindPaneAgentTitleMocks(deps as never, agentTitleMocks3)
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock factory records connectPanePty's typed exit callback.
    const onPtyExit = fixture.transportOptions[0]?.onPtyExit as
      | ((ptyId: string) => void)
      | undefined
    onPtyExit?.('pty-pane-2')

    pending = false
    settleDeferredPtyShutdownExits(['pty-pane-2'], 'rolled-back')

    expect(deps.consumeSuppressedPtyExit).not.toHaveBeenCalled()
    expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(deps.clearRuntimePaneTitle).not.toHaveBeenCalled()
    expect(deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('preserves wake identifiers when exit arrives after a committed shutdown', async () => {
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks4 = await vi.importMock<PtyConnectionAgentTitleMocks>(
      '@/lib/agent-status/aggregation/worktree-agent-status'
    )
    const { markCommittedPtyShutdowns } =
      await import('../../pty-transport/shutdown/pty-shutdown-exit-deferral')
    const transport = createMockTransport('pty-pane-2')
    fixture.transportQueue.push(transport)
    const manager = createManager(1)
    const deps = fixture.createDeps({
      isPtyShutdownPending: vi.fn(() => false),
      consumeSuppressedPtyExit: vi.fn(() => true)
    })

    connectPanePty(
      createPane(2) as never,
      manager as never,
      bindPaneAgentTitleMocks(deps as never, agentTitleMocks4)
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock factory records connectPanePty's typed exit callback.
    const onPtyExit = fixture.transportOptions[0]?.onPtyExit as
      | ((ptyId: string) => void)
      | undefined

    markCommittedPtyShutdowns(['pty-pane-2'])
    onPtyExit?.('pty-pane-2')

    expect(deps.consumeSuppressedPtyExit).toHaveBeenCalledWith('pty-pane-2')
    expect(deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
  })
}
