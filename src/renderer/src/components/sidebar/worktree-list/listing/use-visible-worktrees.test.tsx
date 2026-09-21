// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { makeRepo, makeWorktree } from '../../../worktree-jump-palette-test-fixtures'
import { useVisibleSidebarWorktrees } from './use-visible-worktrees'
import type * as visibleWorktreesModule from '../../visible-worktrees'

const computeVisibleWorktreesCalls = { count: 0 }
vi.mock('../../visible-worktrees', async (importOriginal) => {
  const actual = await importOriginal<typeof visibleWorktreesModule>()
  return {
    ...actual,
    computeVisibleWorktrees: (
      ...args: Parameters<typeof actual.computeVisibleWorktrees>
    ): ReturnType<typeof actual.computeVisibleWorktrees> => {
      computeVisibleWorktreesCalls.count += 1
      return actual.computeVisibleWorktrees(...args)
    }
  }
})

const initialState = useAppStore.getInitialState()

describe('useVisibleSidebarWorktrees', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('projects both host rows through the primary sidebar pipeline', () => {
    const local = makeWorktree('shared', 'Local workspace', { hostId: 'local' })
    const ssh = makeWorktree('shared', 'SSH workspace', { hostId: 'ssh:box' })
    const repo = makeRepo()
    useAppStore.setState({ worktreesByRepo: { [repo.id]: [local, ssh] } })

    const { result } = renderHook(() =>
      useVisibleSidebarWorktrees({
        filterState: {
          showSleepingWorkspaces: true,
          filterRepoIds: [],
          hideDefaultBranchWorkspace: false,
          hideAutomationGeneratedWorkspaces: false,
          hideCliCreatedWorkspaces: false,
          hideDetachedHeadWorkspaces: false,
          hideWorkspacesFromOtherDevices: false,
          alwaysShowDefaultBranchWorkspace: true,
          visibleWorkspaceHostIds: null,
          workspaceHostScope: 'all'
        },
        sortBy: 'recent',
        sortedIds: [local.id, ssh.id],
        repoMap: new Map([[repo.id, repo]]),
        worktreeLineageById: {},
        defaultHostId: LOCAL_EXECUTION_HOST_ID,
        agentSendTargetWorktreeId: null
      })
    )

    expect(result.current.visibleWorktrees.map(getWorktreeHostIdentity)).toEqual([
      getWorktreeHostIdentity(local),
      getWorktreeHostIdentity(ssh)
    ])
  })

  it('does not expand one host-filtered collision into both rows', () => {
    const local = makeWorktree('shared', 'Local workspace', { hostId: 'local' })
    const ssh = makeWorktree('shared', 'SSH workspace', { hostId: 'ssh:box' })
    const repo = makeRepo()
    useAppStore.setState({ worktreesByRepo: { [repo.id]: [local, ssh] } })

    const { result } = renderHook(() =>
      useVisibleSidebarWorktrees({
        filterState: {
          showSleepingWorkspaces: true,
          filterRepoIds: [],
          hideDefaultBranchWorkspace: false,
          hideAutomationGeneratedWorkspaces: false,
          hideCliCreatedWorkspaces: false,
          hideDetachedHeadWorkspaces: false,
          hideWorkspacesFromOtherDevices: false,
          alwaysShowDefaultBranchWorkspace: true,
          visibleWorkspaceHostIds: ['ssh:box'],
          workspaceHostScope: 'all'
        },
        sortBy: 'recent',
        sortedIds: [local.id, ssh.id],
        repoMap: new Map([[repo.id, repo]]),
        worktreeLineageById: {},
        defaultHostId: LOCAL_EXECUTION_HOST_ID,
        agentSendTargetWorktreeId: null
      })
    )

    expect(result.current.visibleWorktrees.map(getWorktreeHostIdentity)).toEqual([
      getWorktreeHostIdentity(ssh)
    ])
  })
  it('does not rescan every worktree when a settings write leaves the focused host unchanged', () => {
    const repo = makeRepo()
    const worktree = makeWorktree('alpha', 'Alpha workspace', { hostId: 'local' })
    useAppStore.setState({ worktreesByRepo: { [repo.id]: [worktree] } })

    const baseArgs = {
      filterState: {
        showSleepingWorkspaces: true,
        filterRepoIds: [],
        hideDefaultBranchWorkspace: false,
        hideAutomationGeneratedWorkspaces: false,
        hideCliCreatedWorkspaces: false,
        hideDetachedHeadWorkspaces: false,
        hideWorkspacesFromOtherDevices: false,
        alwaysShowDefaultBranchWorkspace: true,
        visibleWorkspaceHostIds: null,
        workspaceHostScope: 'all'
      },
      sortBy: 'recent',
      sortedIds: [worktree.id],
      repoMap: new Map([[repo.id, repo]]),
      worktreeLineageById: {},
      defaultHostId: LOCAL_EXECUTION_HOST_ID,
      agentSendTargetWorktreeId: null
    } as Parameters<typeof useVisibleSidebarWorktrees>[0]
    // Why the extra `settings`: it is the pre-fix memo key. Passing it keeps
    // this test red against the old hook, which re-keyed the whole scan on the
    // settings object identity.
    const withSettings = (
      settings: ReturnType<typeof useAppStore.getState>['settings']
    ): Parameters<typeof useVisibleSidebarWorktrees>[0] => Object.assign({}, baseArgs, { settings })

    computeVisibleWorktreesCalls.count = 0
    const { result, rerender } = renderHook(
      (args: Parameters<typeof useVisibleSidebarWorktrees>[0]) => useVisibleSidebarWorktrees(args),
      { initialProps: withSettings(useAppStore.getState().settings) }
    )
    const initialVisible = result.current.visibleWorktrees
    const callsAfterFirstRender = computeVisibleWorktreesCalls.count
    expect(callsAfterFirstRender).toBe(1)

    // A settings write that does not move the focused execution host.
    const nextSettings = {
      ...useAppStore.getState().settings,
      sidebarWidth: 321
    } as ReturnType<typeof useAppStore.getState>['settings']
    useAppStore.setState({ settings: nextSettings })
    rerender(withSettings(nextSettings))

    expect(computeVisibleWorktreesCalls.count).toBe(callsAfterFirstRender)
    expect(result.current.visibleWorktrees).toBe(initialVisible)

    // A write that does move it still recomputes.
    rerender(Object.assign({}, withSettings(nextSettings), { defaultHostId: 'runtime:other' }))
    expect(computeVisibleWorktreesCalls.count).toBe(callsAfterFirstRender + 1)
  })
})
