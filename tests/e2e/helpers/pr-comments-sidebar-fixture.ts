import type { Page } from '@stablyai/playwright-test'
import type { PRComment, PRInfo } from '../../../src/shared/types'

export type PRCommentsSidebarSeed = {
  worktreeId: string
  branch: string
  prNumber: number
}

export const FIXTURE_COMMENTS: PRComment[] = [
  {
    id: 101,
    author: 'alice',
    authorAvatarUrl: '',
    body: 'Please update this handler before merge.',
    createdAt: '2026-05-14T10:00:00.000Z',
    url: 'https://github.com/acme/orca/pull/73#discussion_r101',
    threadId: 'thread-open',
    path: 'src/handler.ts',
    isResolved: false
  },
  {
    id: 102,
    author: 'bob',
    authorAvatarUrl: '',
    body: 'LGTM on the overall approach.',
    createdAt: '2026-05-14T11:00:00.000Z',
    url: 'https://github.com/acme/orca/pull/73#issuecomment-102'
  },
  {
    id: 103,
    author: 'carol',
    authorAvatarUrl: '',
    body: 'Already fixed upstream.',
    createdAt: '2026-05-13T09:00:00.000Z',
    url: 'https://github.com/acme/orca/pull/73#discussion_r103',
    threadId: 'thread-resolved',
    path: 'src/legacy.ts',
    isResolved: true
  }
]

/** Seed an open PR on e2e-secondary with mixed comment triage states for sidebar tests. */
export async function seedPRCommentsSidebarFixture(page: Page): Promise<PRCommentsSidebarSeed> {
  return page.evaluate(async (fixtureComments: PRComment[]) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const state = store.getState()
    const worktrees = Object.values(state.worktreesByRepo).flat()
    const worktree = worktrees.find(
      (entry) => entry.branch.replace(/^refs\/heads\//, '') === 'e2e-secondary'
    )
    if (!worktree) {
      throw new Error('seeded e2e-secondary worktree not found')
    }

    state.setActiveWorktree(worktree.id)
    const repo = state.repos.find((entry) => entry.id === worktree.repoId)
    if (!repo) {
      throw new Error('active repo not found')
    }

    const branch = worktree.branch.replace(/^refs\/heads\//, '')
    const prNumber = 73
    const pr: PRInfo = {
      number: prNumber,
      title: 'E2E PR comments sidebar',
      state: 'open',
      url: `https://github.com/acme/orca/pull/${prNumber}`,
      checksStatus: 'pending',
      updatedAt: '2026-05-15T00:00:00.000Z',
      mergeable: 'MERGEABLE'
    }
    const prCacheEntries = {
      [`${repo.id}::${branch}`]: {
        data: pr,
        fetchedAt: Date.now()
      },
      [`${repo.path}::${branch}`]: {
        data: pr,
        fetchedAt: Date.now()
      }
    }

    const comments = fixtureComments

    store.setState((current) => ({
      prCache: {
        ...current.prCache,
        ...prCacheEntries
      },
      repos: current.repos.map((candidate) =>
        candidate.id === repo.id ? { ...candidate, worktreeBaseRef: 'origin/main' } : candidate
      ),
      gitStatusByWorktree: {
        ...current.gitStatusByWorktree,
        [worktree.id]: []
      },
      remoteStatusesByWorktree: {
        ...current.remoteStatusesByWorktree,
        [worktree.id]: {
          hasUpstream: true,
          upstreamName: `origin/${branch}`,
          ahead: 0,
          behind: 0
        }
      },
      settings: current.settings
        ? {
            ...current.settings,
            sourceControlAi: {
              ...current.settings.sourceControlAi,
              enabled: true
            }
          }
        : current.settings,
      fetchPRForBranch: async (repoPath: string, targetBranch: string) => {
        if (targetBranch !== branch) {
          return null
        }
        store.setState((next) => ({
          prCache: {
            ...next.prCache,
            ...prCacheEntries
          }
        }))
        return pr
      },
      fetchPRChecks: async () => [],
      fetchPRComments: async () => comments,
      fetchUpstreamStatus: async () => undefined,
      setUpstreamStatus: () => undefined
    }))

    window.localStorage.setItem('orca:pr-comment-presentation', 'cards')

    return { worktreeId: worktree.id, branch, prNumber }
  }, FIXTURE_COMMENTS)
}
