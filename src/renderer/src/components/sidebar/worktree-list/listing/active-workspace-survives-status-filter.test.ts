// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/store-test-helpers'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import type { Repo } from '../../../../../../shared/repo-types'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../../../shared/workspace-statuses'
import { useVisibleSidebarWorktrees } from './use-visible-worktrees'
import type { SidebarWorktreeFilters } from './use-filters'

const initialState = useAppStore.getInitialState()

const REPO: Repo = {
  id: 'repo1',
  path: '/tmp/repo1',
  displayName: 'Repo 1',
  badgeColor: '#000',
  addedAt: 0
}

// The active workspace sits on a status the filter excludes — the state you land
// in by running "Move to Status" on the row you are working in.
const ACTIVE_ID = 'repo1::/tmp/active'
const TODO_ID = 'repo1::/tmp/todo'

const WORKTREES = {
  repo1: [
    makeWorktree({ id: ACTIVE_ID, repoId: 'repo1', displayName: 'active', path: '/tmp/active' }),
    makeWorktree({ id: TODO_ID, repoId: 'repo1', displayName: 'todo', path: '/tmp/todo' })
  ]
}

function filterState(
  overrides: Partial<SidebarWorktreeFilters['filterState']> = {}
): SidebarWorktreeFilters['filterState'] {
  return {
    showSleepingWorkspaces: true,
    filterRepoIds: [],
    filterWorkspaceStatuses: [],
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    alwaysShowDefaultBranchWorkspace: true,
    visibleWorkspaceHostIds: null,
    workspaceHostScope: 'all',
    ...overrides
  }
}

function seed(activeStatus: string, selected: readonly string[]): void {
  useAppStore.setState(
    {
      ...initialState,
      settings: getDefaultSettings('/tmp'),
      repos: [REPO],
      worktreesByRepo: {
        repo1: [
          { ...WORKTREES.repo1[0]!, workspaceStatus: activeStatus },
          { ...WORKTREES.repo1[1]!, workspaceStatus: 'todo' }
        ]
      },
      workspaceStatuses: [...DEFAULT_WORKSPACE_STATUSES],
      filterWorkspaceStatuses: selected,
      activeWorktreeId: ACTIVE_ID
    },
    true
  )
}

function renderVisibleIds(
  overrides: Partial<SidebarWorktreeFilters['filterState']> = {}
): string[] {
  const state = useAppStore.getState()
  const worktrees = state.worktreesByRepo.repo1 ?? []
  const { result } = renderHook(() =>
    useVisibleSidebarWorktrees({
      filterState: filterState(overrides),
      sortBy: 'manual',
      sortedIds: worktrees.map((w) => w.id),
      repoMap: new Map([[REPO.id, REPO]]),
      worktreeLineageById: {},
      settings: state.settings,
      agentSendTargetWorktreeId: null
    })
  )
  return result.current.visibleWorktrees.map((w) => w.id)
}

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('active workspace under a card-status filter', () => {
  it('keeps the active workspace listed after its status is filtered out', () => {
    seed('completed', ['todo'])

    const ids = renderVisibleIds({ filterWorkspaceStatuses: ['todo'] })

    // Without the active-workspace pin this is just ['repo1::/tmp/todo'] — the
    // row you are working in disappears while its panes stay open.
    expect(ids).toContain(ACTIVE_ID)
    expect(ids).toContain(TODO_ID)
  })

  it('still filters non-active workspaces off the excluded status', () => {
    seed('todo', ['todo'])
    useAppStore.setState({
      worktreesByRepo: {
        repo1: [
          { ...WORKTREES.repo1[0]!, workspaceStatus: 'todo' },
          { ...WORKTREES.repo1[1]!, workspaceStatus: 'completed' }
        ]
      }
    })

    const ids = renderVisibleIds({ filterWorkspaceStatuses: ['todo'] })

    expect(ids).toEqual([ACTIVE_ID])
  })

  // Why: the pin is gated on the status filter precisely so it does not widen
  // any other filter. Status is the only dimension reachable from the row.
  it('does not pin the active workspace when no status filter is set', () => {
    seed('completed', [])
    useAppStore.setState({
      worktreesByRepo: {
        repo1: [
          { ...WORKTREES.repo1[0]!, workspaceStatus: 'completed', repoId: 'repo1' },
          { ...WORKTREES.repo1[1]!, workspaceStatus: 'todo' }
        ]
      }
    })

    const ids = renderVisibleIds({ filterRepoIds: ['repo-other'] })

    expect(ids).toEqual([])
  })
})

// Keeps the fixture honest: the excluded status must really be in the catalog,
// otherwise sanitization would drop the filter and the first case would pass
// for the wrong reason.
describe('fixture', () => {
  it('uses catalog statuses the filter can actually select', () => {
    const ids = DEFAULT_WORKSPACE_STATUSES.map((s) => s.id)
    expect(ids).toContain('todo')
    expect(ids).toContain('completed')
    expect(LOCAL_EXECUTION_HOST_ID).toBeTruthy()
  })
})
