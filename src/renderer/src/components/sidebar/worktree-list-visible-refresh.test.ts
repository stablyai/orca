import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getGitHubPRRefreshIdentity,
  hasGitHubPRRefreshIdentity,
  installWorktreeVisibleRefreshVisibilityListener
} from './WorktreeList'

describe('installWorktreeVisibleRefreshVisibilityListener', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('subscribes to document visibility changes so visible PR refresh can rerun on return', () => {
    const listeners = new Map<string, () => void>()
    const onChange = vi.fn()
    const addEventListener = vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener)
    })
    const removeEventListener = vi.fn()

    vi.stubGlobal('document', {
      addEventListener,
      removeEventListener
    })

    const cleanup = installWorktreeVisibleRefreshVisibilityListener(onChange)

    expect(addEventListener).toHaveBeenCalledWith('visibilitychange', onChange)
    listeners.get('visibilitychange')?.()
    expect(onChange).toHaveBeenCalledTimes(1)

    cleanup()
    expect(removeEventListener).toHaveBeenCalledWith('visibilitychange', onChange)
  })

  it('tracks detached worktrees by head for visible PR refreshes', () => {
    expect(
      hasGitHubPRRefreshIdentity({
        isBare: false,
        branch: '',
        head: '67c9b9565d1596f40afbb5d4acb1ee71e56e1c4e'
      })
    ).toBe(true)
    expect(
      getGitHubPRRefreshIdentity({
        id: 'repo-1::C:/Users/neil/orca/workspaces/demo-project-6470-detached-24',
        branch: '',
        head: '67c9b9565d1596f40afbb5d4acb1ee71e56e1c4e',
        linkedPR: null
      })
    ).toBe(
      'repo-1::C:/Users/neil/orca/workspaces/demo-project-6470-detached-24:67c9b9565d1596f40afbb5d4acb1ee71e56e1c4e:'
    )
  })

  it('keeps branch worktree refresh identity branch-scoped', () => {
    expect(
      getGitHubPRRefreshIdentity({
        id: 'repo-1::/repo/worktrees/feature',
        branch: 'feature/local-branch',
        head: 'abc123',
        linkedPR: 42
      })
    ).toBe('repo-1::/repo/worktrees/feature:feature/local-branch:42')
  })

  it('does not track worktrees without branch or head identity', () => {
    expect(hasGitHubPRRefreshIdentity({ isBare: false, branch: '', head: '' })).toBe(false)
    expect(hasGitHubPRRefreshIdentity({ isBare: true, branch: 'main', head: 'abc123' })).toBe(false)
  })
})
