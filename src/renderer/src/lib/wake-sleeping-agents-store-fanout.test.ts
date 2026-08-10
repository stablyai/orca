import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'

function topologyState(): AppState {
  return {
    workspaceSessionReady: true,
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    remoteWorkspaceHydratedTargetIds: new Set(),
    sshConnectionStates: new Map(),
    remoteWorkspaceSyncStatusByTargetId: {}
  } as unknown as AppState
}

describe('background sleeping-agent wake store fanout', () => {
  it('bounds hot unrelated writes without recomputing target topology', async () => {
    const subscriberRef: {
      current: ((state: AppState, previousState: AppState) => void) | null
    } = { current: null }
    let state = topologyState()
    vi.doMock('@/store', () => ({
      useAppStore: {
        getState: () => state,
        subscribe: (listener: (next: AppState, previous: AppState) => void) => {
          subscriberRef.current = listener
          return () => {}
        }
      }
    }))
    const { createBackgroundSleepingAgentWakeDispatcher } =
      await import('./wake-sleeping-agents-in-background')
    const recomputeTargetTopology = vi.fn(() => 'target-a')
    const dispatcher = createBackgroundSleepingAgentWakeDispatcher({
      getRemoteHydrationTargetId: recomputeTargetTopology
    })
    dispatcher.remotePullStarted('target-a')
    expect(dispatcher.requestActivation('worktree-a')).toBe(true)

    const startedAt = performance.now()
    for (let index = 0; index < 20_000; index += 1) {
      const previous = state
      state = {
        ...state,
        agentStatusByPaneKey: { [`pane-${index}`]: { state: 'working' } },
        terminalLayoutsByTabId: { [`tab-${index}`]: null }
      } as unknown as AppState
      subscriberRef.current?.(state, previous)
    }
    const durationMs = performance.now() - startedAt

    expect(recomputeTargetTopology).toHaveBeenCalledOnce()
    expect(durationMs).toBeLessThan(250)

    const previous = state
    state = { ...state, repos: [{}] } as unknown as AppState
    subscriberRef.current?.(state, previous)
    expect(recomputeTargetTopology).toHaveBeenCalledTimes(2)
    dispatcher.dispose()
  })
})
