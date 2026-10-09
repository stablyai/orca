import { describe, expect, it, vi } from 'vitest'
import { setupTerminalCreateSurfacing } from './ipc-events-terminal-create-test-harness'

const LEAF = '88888888-8888-4888-8888-888888888888'

describe('a launch tab while its agent is starting', () => {
  it('stays closed when the user closed it, and its agent stops, as closing any tab stops it', async () => {
    const scenario = await setupTerminalCreateSurfacing(() => false)
    const { createTab, replyTerminalCreate, createTerminalListenerRef, storeState } = scenario
    if (!createTerminalListenerRef.current) {
      throw new Error('Expected the create-terminal listener to be registered')
    }
    const kill = vi.fn(async () => {})
    Object.assign(window.api, { pty: { kill } })
    storeState.tabsByWorktree['wt-1'] = []
    // The harness resets modules; the bridge reads the instance it imported.
    const { noteAgentLaunchPaneClosedByUser } = await import('@/lib/agent-launch-pane-closes')
    noteAgentLaunchPaneClosedByUser('tab-closed', LEAF)

    createTerminalListenerRef.current({
      requestId: 'reveal-closed-launch-tab',
      worktreeId: 'wt-1',
      ptyId: 'pty-agent',
      tabId: 'tab-closed',
      leafId: LEAF,
      surfaceOwner: false
    })

    expect(createTab).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledWith('pty-agent')
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'reveal-closed-launch-tab',
      error: 'agent_launch_tab_closed'
    })
  })

  it('is brought back, agent running, when the window merely lost it (a reload before it saved)', async () => {
    const scenario = await setupTerminalCreateSurfacing(() => false)
    const { createTab, createTerminalListenerRef, storeState } = scenario
    if (!createTerminalListenerRef.current) {
      throw new Error('Expected the create-terminal listener to be registered')
    }
    const kill = vi.fn(async () => {})
    Object.assign(window.api, { pty: { kill } })
    storeState.tabsByWorktree['wt-1'] = []

    createTerminalListenerRef.current({
      requestId: 'reveal-reloaded-launch-tab',
      worktreeId: 'wt-1',
      ptyId: 'pty-agent',
      tabId: 'tab-reloaded',
      leafId: LEAF,
      surfaceOwner: false
    })

    expect(kill).not.toHaveBeenCalled()
    expect(createTab).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.objectContaining({ id: 'tab-reloaded', initialPtyId: 'pty-agent' })
    )
  })
})

describe('a launch tab this window made, which the host never showed early', () => {
  it('takes the agent the host reveals under its own id, and lets its pane attach at once', async () => {
    const scenario = await setupTerminalCreateSurfacing(() => false)
    const { createTab, updateTabPtyId, createTerminalListenerRef, storeState } = scenario
    if (!createTerminalListenerRef.current) {
      throw new Error('Expected the create-terminal listener to be registered')
    }
    Object.assign(window.api, { pty: { kill: vi.fn(async () => {}) } })
    // The harness resets modules; the bridge reads the instance it imported.
    const { holdAgentLaunchPaneSpawn, agentLaunchPaneSpawnHold } =
      await import('@/lib/agent-launch-pane-spawn-hold')
    holdAgentLaunchPaneSpawn('tab-made', LEAF)
    storeState.tabsByWorktree['wt-1'] = [
      { id: 'tab-made', ptyId: null, agentLaunchPane: { leafId: LEAF } }
    ]
    storeState.terminalLayoutsByTabId['tab-made'] = { root: { type: 'leaf', leafId: LEAF } }
    const held = agentLaunchPaneSpawnHold('tab-made', LEAF)

    createTerminalListenerRef.current({
      requestId: 'reveal-window-made-launch-tab',
      worktreeId: 'wt-1',
      ptyId: 'pty-agent',
      tabId: 'tab-made',
      leafId: LEAF
    })

    // Never a second tab under the same id, and the waiting pane is let go to attach.
    expect(createTab).not.toHaveBeenCalled()
    expect(updateTabPtyId).toHaveBeenCalledWith('tab-made', 'pty-agent')
    await expect(held).resolves.toBeUndefined()
    expect(agentLaunchPaneSpawnHold('tab-made', LEAF)).toBeNull()
  })
})
