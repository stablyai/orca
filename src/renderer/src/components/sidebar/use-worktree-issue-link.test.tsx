// @vitest-environment happy-dom

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { useWorktreeIssueLink } from './use-worktree-issue-link'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('useWorktreeIssueLink', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens a linked issue through the worktree execution host when repo ids overlap', async () => {
    const fetchIssue = vi.fn().mockResolvedValue(null)
    useAppStore.setState({
      repos: [
        { id: 'repo-1', path: '/local/repo', executionHostId: 'local' },
        {
          id: 'repo-1',
          path: '/ssh/repo',
          connectionId: 'ssh-1',
          executionHostId: 'ssh:ssh-1'
        }
      ],
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            hostId: 'local',
            path: '/local/repo/worktrees/feature'
          },
          {
            id: 'wt-1',
            repoId: 'repo-1',
            hostId: 'ssh:ssh-1',
            path: '/ssh/repo/worktrees/feature'
          }
        ]
      },
      fetchIssue
    } as never)

    const { result } = renderHook(() =>
      useWorktreeIssueLink({
        worktreeId: 'wt-1',
        ownerRepoId: 'repo-1',
        ownerExecutionHostId: 'ssh:ssh-1',
        issueInput: '42',
        issueProvider: 'github'
      })
    )

    await act(async () => {
      await result.current.handleOpenIssue()
    })

    expect(fetchIssue).toHaveBeenCalledWith('/ssh/repo', 42, {
      repoId: 'repo-1',
      executionHostId: 'ssh:ssh-1'
    })
  })

  it('does not fall through to another repo bucket for an explicit owner', async () => {
    const fetchIssue = vi.fn().mockResolvedValue(null)
    useAppStore.setState({
      repos: [
        { id: 'repo-1', path: '/local/repo', executionHostId: 'local' },
        { id: 'repo-2', path: '/ssh/repo', executionHostId: 'ssh:ssh-1' }
      ],
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1', hostId: 'local', path: '/local/worktree' }],
        'repo-2': [{ id: 'wt-1', repoId: 'repo-2', hostId: 'ssh:ssh-1', path: '/ssh/worktree' }]
      },
      fetchIssue
    } as never)

    const { result } = renderHook(() =>
      useWorktreeIssueLink({
        worktreeId: 'wt-1',
        ownerRepoId: 'repo-1',
        ownerExecutionHostId: 'ssh:ssh-1',
        issueInput: '42',
        issueProvider: 'github'
      })
    )

    await act(async () => {
      await result.current.handleOpenIssue()
    })

    expect(result.current.canOpenIssue).toBe(false)
    expect(fetchIssue).not.toHaveBeenCalled()
  })
})
