import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { activateAndRevealWorktree } from './worktree-activation'
import * as activationGate from './worktree-agent-activation-gate'
import { ensureWorktreeHasInitialTerminal } from './initial-surface/worktree-initial-terminal-seeding'
import {
  makeCreatedAgentWorktree as makeWorktree,
  seedEmptyActivatableWorktree
} from '@/lib/workspace/activation/worktree-activation-created-agent.test-fixture'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useAppStore.setState(initialAppStoreState, true)
})

/** The state a workspace lands in once its last terminal is closed: the row survives as an
 *  explicit empty list rather than disappearing, beside the close's record. */
function seedClosedLastTerminal(worktreeId: string): void {
  useAppStore.setState({
    tabsByWorktree: { [worktreeId]: [] },
    closedTerminalTabTombstonesByTabId: { closed: { closedAt: Date.now(), worktreeId } }
  })
  const { renderableTabCount } = useAppStore.getState().reconcileWorktreeTabModel(worktreeId)
  expect(renderableTabCount).toBe(0)
}

describe('activating a workspace whose last terminal was closed', () => {
  it('lets the latest caller surface supersede an older callback on the shared gate', async () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        'pane-1': { worktreeId: worktree.id }
      } as never
    })
    let resolveGate!: (outcome: activationGate.WorktreeAgentActivationOutcome) => void
    const pendingGate = new Promise<activationGate.WorktreeAgentActivationOutcome>((resolve) => {
      resolveGate = resolve
    })
    vi.spyOn(activationGate, 'gateWorktreeAgentActivation').mockReturnValue(pendingGate)

    activateAndRevealWorktree(worktree.id, { agent: 'codex', notifyHostRuntime: false })
    activateAndRevealWorktree(worktree.id, {
      providesInitialSurface: true,
      notifyHostRuntime: false
    })
    resolveGate('empty')
    await pendingGate

    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toEqual([])
  })

  it('does not double-seed when another recovery creates a tab before the gate settles', async () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        'pane-1': { worktreeId: worktree.id }
      } as never
    })
    let resolveGate!: (outcome: activationGate.WorktreeAgentActivationOutcome) => void
    const pendingGate = new Promise<activationGate.WorktreeAgentActivationOutcome>((resolve) => {
      resolveGate = resolve
    })
    vi.spyOn(activationGate, 'gateWorktreeAgentActivation').mockReturnValue(pendingGate)

    activateAndRevealWorktree(worktree.id, { agent: 'codex', notifyHostRuntime: false })
    const recoveredTabId = ensureWorktreeHasInitialTerminal(
      useAppStore.getState(),
      worktree.id,
      undefined,
      undefined,
      undefined,
      undefined,
      { reseedEmptiedWorkspace: true }
    )
    resolveGate('empty')
    await pendingGate

    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toHaveLength(1)
    expect(useAppStore.getState().tabsByWorktree[worktree.id]?.[0]?.id).toBe(recoveredTabId)
  })
})
