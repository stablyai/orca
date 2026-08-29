// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { makeRepo, makeWorktree } from '../../../worktree-jump-palette-test-fixtures'
import { useVisibleSidebarWorktrees } from './use-visible-worktrees'

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
        settings: useAppStore.getState().settings,
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
        settings: useAppStore.getState().settings,
        agentSendTargetWorktreeId: null
      })
    )

    expect(result.current.visibleWorktrees.map(getWorktreeHostIdentity)).toEqual([
      getWorktreeHostIdentity(ssh)
    ])
  })
})
