import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'

const state = () => useAppStore.getState()

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('setShowSleepingWorkspaces', () => {
  it('reveals the open workspace when sleeping rows are shown again', () => {
    useAppStore.setState({
      activeWorktreeId: 'wt-active',
      activeWorkspaceKey: 'worktree:wt-active',
      activeWorkspaceExecutionHostId: 'local',
      showSleepingWorkspaces: false
    })

    state().setShowSleepingWorkspaces(true)

    expect(state().showSleepingWorkspaces).toBe(true)
    expect(state().pendingRevealWorktree).toMatchObject({
      worktreeId: 'wt-active',
      executionHostId: 'local'
    })
  })

  it('leaves the viewport alone when the toggle hides sleeping rows', () => {
    useAppStore.setState({
      activeWorktreeId: 'wt-active',
      activeWorkspaceKey: 'worktree:wt-active',
      showSleepingWorkspaces: true
    })

    state().setShowSleepingWorkspaces(false)

    expect(state().showSleepingWorkspaces).toBe(false)
    expect(state().pendingRevealWorktree).toBeNull()
  })

  it('does nothing when the value is unchanged', () => {
    useAppStore.setState({
      activeWorktreeId: 'wt-active',
      activeWorkspaceKey: 'worktree:wt-active',
      showSleepingWorkspaces: true
    })

    state().setShowSleepingWorkspaces(true)

    expect(state().pendingRevealWorktree).toBeNull()
  })

  it('toggles the filter without a reveal when no workspace is open', () => {
    useAppStore.setState({ activeWorktreeId: null, activeWorkspaceKey: null })

    state().setShowSleepingWorkspaces(true)

    expect(state().showSleepingWorkspaces).toBe(true)
    expect(state().pendingRevealWorktree).toBeNull()
  })
})
