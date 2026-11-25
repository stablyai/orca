// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useShallow } from 'zustand/react/shallow'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { useAppStore } from '@/store/index'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import { selectSidebarFilterState } from '../controls/sidebar-filter-actions'
import { markWorktreeFilterExemptWhileActive } from './active-filter-exempt-worktree'
import { useVisibleSidebarWorktrees } from './use-visible-worktrees'

const EMPTY_LINEAGE: Record<string, WorktreeLineage> = {}

function seedFilteredSidebarWorkspaceStore() {
  const repo: Repo = TEST_REPO
  const defaultWt = makeWorktree({
    id: `${repo.id}::/main`,
    repoId: repo.id,
    path: `${repo.path}`,
    branch: 'refs/heads/main',
    isMainWorktree: true,
    displayName: 'main',
    workspaceStatus: 'todo'
  })
  const sleepingWt = makeWorktree({
    id: `${repo.id}::/sleeping`,
    repoId: repo.id,
    path: `${repo.path}-sleeping`,
    branch: 'refs/heads/feat-sleeping',
    isMainWorktree: false,
    displayName: 'feat-sleeping',
    workspaceStatus: 'todo'
  })
  const otherWt = makeWorktree({
    id: `${repo.id}::/other-awake`,
    repoId: repo.id,
    path: `${repo.path}-other-awake`,
    branch: 'refs/heads/feat-other',
    isMainWorktree: false,
    displayName: 'feat-other',
    workspaceStatus: 'in_progress'
  })

  useAppStore.setState({
    repos: [repo],
    worktreesByRepo: { [repo.id]: [defaultWt, sleepingWt, otherWt] },
    tabsByWorktree: {
      [otherWt.id]: [makeTab({ id: 'tab-other', worktreeId: otherWt.id, ptyId: 'pty-other' })]
    },
    ptyIdsByTabId: {
      'tab-other': ['pty-other']
    },
    showSleepingWorkspaces: false,
    hideDefaultBranchWorkspace: true,
    alwaysShowDefaultBranchWorkspace: false,
    activeRepoId: repo.id,
    activeWorktreeId: otherWt.id
  })

  return {
    repo,
    defaultWt,
    sleepingWt,
    otherWt,
    repoMap: new Map<string, Repo>([[repo.id, repo]]),
    sortedIds: [defaultWt, sleepingWt, otherWt].map((worktree) => getWorktreeHostIdentity(worktree))
  }
}

function renderVisibleWorktreesHook(repoMap: Map<string, Repo>, sortedIds: string[]) {
  return renderHook(() => {
    const filterState = useAppStore(useShallow(selectSidebarFilterState))
    return useVisibleSidebarWorktrees({
      filterState,
      sortBy: 'manual',
      sortedIds,
      repoMap,
      worktreeLineageById: EMPTY_LINEAGE,
      defaultHostId: 'local',
      agentSendTargetWorktreeId: null
    })
  })
}

beforeEach(() => {
  vi.stubGlobal('api', {
    ...window.api,
    gh: { ...window.api?.gh, enqueuePRRefresh: () => Promise.resolve(true) },
    runtime: {
      ...window.api?.runtime,
      call: () => Promise.resolve({ ok: true, result: { bots: [] } })
    }
  })
})

afterEach(() => {
  cleanup()
  markWorktreeFilterExemptWhileActive(null)
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.unstubAllGlobals()
})

describe('active filter-exempt worktree on workspace jump', () => {
  it('keeps a sleeping worktree visible after jump while active and hides it again when switching away', () => {
    const { repo, sleepingWt, otherWt, repoMap, sortedIds } = seedFilteredSidebarWorkspaceStore()
    const { result } = renderVisibleWorktreesHook(repoMap, sortedIds)

    expect(result.current.visibleWorktrees.map((w) => w.id)).toEqual([otherWt.id])

    act(() => {
      activateAndRevealWorkspace(sleepingWt.id, { navigationIntent: 'user-open' })
    })

    expect(result.current.visibleWorktrees.map((w) => w.id)).toEqual([sleepingWt.id, otherWt.id])
    expect(useAppStore.getState().showSleepingWorkspaces).toBe(false)
    expect(useAppStore.getState().pendingRevealWorktree?.worktreeId).toBe(sleepingWt.id)

    // Re-activating without reveal (such as clicking the visible exempt row) keeps the exemption.
    act(() => {
      activateAndRevealWorkspace(sleepingWt.id, {
        navigationIntent: 'user-open',
        revealInSidebar: false
      })
    })
    expect(result.current.visibleWorktrees.map((w) => w.id)).toEqual([sleepingWt.id, otherWt.id])

    // Updating workspaceStatus while active does not drop the exemption.
    act(() => {
      useAppStore.setState((state) => ({
        worktreesByRepo: {
          ...state.worktreesByRepo,
          [repo.id]: (state.worktreesByRepo[repo.id] ?? []).map((worktree) =>
            worktree.id === sleepingWt.id
              ? { ...worktree, workspaceStatus: 'in_progress' }
              : worktree
          )
        }
      }))
    })
    expect(result.current.visibleWorktrees.map((w) => w.id)).toEqual([sleepingWt.id, otherWt.id])

    // Switching activeWorktreeId away clears the exemption and hides the sleeping worktree again.
    act(() => {
      useAppStore.getState().setActiveWorktree(otherWt.id)
    })
    expect(result.current.visibleWorktrees.map((w) => w.id)).toEqual([otherWt.id])
  })

  it('keeps a hidden default-branch worktree visible after jump while active and clears when switching activeWorktreeId', () => {
    const { defaultWt, otherWt, repoMap, sortedIds } = seedFilteredSidebarWorkspaceStore()
    const { result } = renderVisibleWorktreesHook(repoMap, sortedIds)

    expect(result.current.visibleWorktrees.map((w) => w.id)).toEqual([otherWt.id])

    act(() => {
      activateAndRevealWorkspace(defaultWt.id, { navigationIntent: 'user-open' })
    })

    expect(result.current.visibleWorktrees.map((w) => w.id)).toEqual([defaultWt.id, otherWt.id])
    expect(useAppStore.getState().hideDefaultBranchWorkspace).toBe(true)
    expect(useAppStore.getState().pendingRevealWorktree?.worktreeId).toBe(defaultWt.id)

    act(() => {
      useAppStore.setState({ activeWorktreeId: otherWt.id })
    })

    expect(result.current.visibleWorktrees.map((w) => w.id)).toEqual([otherWt.id])
  })

  it('does not exempt a worktree opened with clearSidebarFilters: false and revealInSidebar: false', () => {
    const { defaultWt, sleepingWt, otherWt, repoMap, sortedIds } =
      seedFilteredSidebarWorkspaceStore()
    const { result } = renderVisibleWorktreesHook(repoMap, sortedIds)

    act(() => {
      activateAndRevealWorkspace(defaultWt.id, { navigationIntent: 'user-open' })
    })
    expect(result.current.visibleWorktrees.map((w) => w.id)).toEqual([defaultWt.id, otherWt.id])

    act(() => {
      useAppStore.getState().clearPendingRevealWorktreeId()
      activateAndRevealWorkspace(sleepingWt.id, {
        clearSidebarFilters: false,
        revealInSidebar: false
      })
    })

    expect(result.current.visibleWorktrees.map((w) => w.id)).toEqual([otherWt.id])
    expect(useAppStore.getState().pendingRevealWorktree).toBeNull()
  })
})
