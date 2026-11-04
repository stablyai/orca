import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'
import { getWorktreeVisitKey } from './worktree-visit-recency'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
  vi.useRealTimers()
})

function worktree(name: string): Worktree {
  return {
    id: `repo-1::/workspace/${name}`,
    repoId: 'repo-1',
    path: `/workspace/${name}`,
    head: 'abc123',
    branch: `refs/heads/${name}`,
    isBare: false,
    isMainWorktree: false,
    displayName: name,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

describe('switching workspaces with the sidebar-inputs switch on', () => {
  it('marks the workspace you leave as used up to now, just before the one you open', () => {
    vi.useFakeTimers({ now: 50_000, toFake: ['Date'] })
    const shells = worktree('shells')
    const next = worktree('next')
    useAppStore.setState({
      repos: [
        { id: 'repo-1', path: '/workspace/repo', displayName: 'repo', badgeColor: '', addedAt: 0 }
      ],
      worktreesByRepo: { 'repo-1': [shells, next] },
      activeRepoId: 'repo-1',
      activeView: 'terminal',
      activeWorktreeId: shells.id,
      activeWorkspaceExecutionHostId: 'local',
      tabsByWorktree: { [shells.id]: [], [next.id]: [] },
      ptyIdsByTabId: {},
      everActivatedWorktreeIds: new Set([shells.id, next.id]),
      lastVisitedAtByWorktreeId: {},
      refreshGitHubForWorktreeIfStale: vi.fn()
    })

    activateAndRevealWorktree(next.id)

    expect(useAppStore.getState().lastVisitedAtByWorktreeId).toEqual({
      [getWorktreeVisitKey(shells.id, 'local')]: 49_999,
      [next.id]: 50_000
    })
  })
})
