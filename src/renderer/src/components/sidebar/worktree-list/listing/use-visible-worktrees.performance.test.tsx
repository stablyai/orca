// @vitest-environment happy-dom
import { useEffect } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { buildAgentStatusScaleFixture } from '@/store/slices/agent-status/agent-status-scale.test-fixture'
import { forgetWorktreeSleepIntent, markWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import { useVisibleSidebarWorktrees } from './use-visible-worktrees'

const initialState = useAppStore.getInitialState()

afterEach(() => {
  cleanup()
  forgetWorktreeSleepIntent('wt-18')
  useAppStore.setState(initialState, true)
  vi.useRealTimers()
})

// Heartbeats change no visible membership; ending the deliberately slept row's last agent removes one row.
describe('visible sidebar worktree subscription contract', () => {
  it.each([40, 400])('retains the visible list through heartbeats at %i worktrees', (count) => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000_000)
    const fixture = buildAgentStatusScaleFixture(undefined, count)
    useAppStore.setState(initialState, true)
    useAppStore.setState({
      ...fixture.state,
      agentStatusByPaneKey: fixture.agentStatusByPaneKey,
      refreshGitHubForWorktreeIfStale: vi.fn().mockResolvedValue(undefined)
    })
    const args: Parameters<typeof useVisibleSidebarWorktrees>[0] = {
      filterState: {
        showSleepingWorkspaces: false,
        filterRepoIds: [],
        hideDefaultBranchWorkspace: false,
        hideAutomationGeneratedWorkspaces: false,
        hideCliCreatedWorkspaces: false,
        hideDetachedHeadWorkspaces: false,
        hideWorkspacesFromOtherDevices: false,
        alwaysShowDefaultBranchWorkspace: false,
        visibleWorkspaceHostIds: null,
        workspaceHostScope: 'all'
      },
      sortBy: 'recent',
      sortedIds: Object.keys(fixture.state.tabsByWorktree),
      repoMap: new Map(fixture.state.repos.map((repo) => [repo.id, repo])),
      worktreeLineageById: {},
      defaultHostId: LOCAL_EXECUTION_HOST_ID,
      agentSendTargetWorktreeId: null
    }
    let commits = 0
    let visible: ReturnType<typeof useVisibleSidebarWorktrees>['visibleWorktrees'] = []
    function Probe() {
      const result = useVisibleSidebarWorktrees(args)
      useEffect(() => {
        commits += 1
        visible = result.visibleWorktrees
      })
      return null
    }
    render(<Probe />)
    expect(visible).toHaveLength(count)
    const baseline = visible
    commits = 0
    const index = fixture.owners.findIndex((owner) => owner.worktreeId === 'wt-18')
    for (let tick = 1; tick <= 20; tick += 1) {
      act(() =>
        useAppStore
          .getState()
          .setAgentStatus(
            fixture.paneKeys[index],
            { state: 'working', agentType: 'claude', prompt: 'initial prompt' },
            undefined,
            { updatedAt: 2_000_000_000 + tick },
            fixture.owners[index]
          )
      )
      expect(commits).toBe(0)
      expect(visible).toBe(baseline)
    }
    markWorktreeSleepIntent('wt-18')
    act(() =>
      useAppStore
        .getState()
        .setAgentStatus(
          fixture.paneKeys[index],
          { state: 'done', agentType: 'claude', prompt: 'initial prompt' },
          undefined,
          { updatedAt: 2_000_000_021 },
          fixture.owners[index]
        )
    )
    expect(commits).toBe(1)
    expect(visible.some((worktree) => worktree.id === 'wt-18')).toBe(false)
  })
})
