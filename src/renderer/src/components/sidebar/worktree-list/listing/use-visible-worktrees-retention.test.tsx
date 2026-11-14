// @vitest-environment happy-dom

import 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import {
  makeRepo,
  makeTerminalTab,
  makeWorktree
} from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import '../../../../../../shared/sidebar-list/selection/sleeping-sweep-retention'
import {
  forgetWorktreeSleepIntent,
  markWorktreeSleepIntent
} from '@/lib/workspace/sleep/worktree-sleep-intent'
import { useVisibleSidebarWorktrees } from './use-visible-worktrees'

const initialState = useAppStore.getInitialState()
const repo = makeRepo()
const worktree = makeWorktree('remote', 'Remote workspace', { hostId: 'ssh:box' })
const tab = makeTerminalTab('terminal', worktree.id, 'Remote session')
const ptyId = 'remote:pty-1'
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
  sortedIds: [worktree.id],
  repoMap: new Map([[repo.id, repo]]),
  worktreeLineageById: {},
  defaultHostId: LOCAL_EXECUTION_HOST_ID,
  agentSendTargetWorktreeId: null
}

function setPtyBound(bound: boolean): void {
  act(() => useAppStore.setState({ ptyIdsByTabId: { [tab.id]: bound ? [ptyId] : [] } }))
}

function visibleIds(result: ReturnType<typeof useVisibleSidebarWorktrees>): string[] {
  return result.visibleWorktrees.map((row) => row.id)
}

describe('useVisibleSidebarWorktrees sleeping retention', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    useAppStore.setState(initialState, true)
    useAppStore.setState({
      worktreesByRepo: { [repo.id]: [worktree] },
      tabsByWorktree: { [worktree.id]: [tab] },
      ptyIdsByTabId: { [tab.id]: [ptyId] }
    })
  })

  afterEach(() => {
    cleanup()
    forgetWorktreeSleepIntent(worktree.id)
    useAppStore.setState(initialState, true)
    vi.useRealTimers()
  })

  it('sweeps a deliberately slept row without a grace window', () => {
    const { result } = renderHook(() => useVisibleSidebarWorktrees(args))
    markWorktreeSleepIntent(worktree.id)
    setPtyBound(false)
    expect(visibleIds(result.current)).toEqual([])
  })
})
