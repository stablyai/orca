import type { AppState } from '@/store/types'

export function directWorkItemProjectFixture(): Pick<
  AppState,
  'repos' | 'activeRepoId' | 'activeWorktreeId' | 'projects'
> {
  return {
    repos: [
      {
        id: 'repo-1',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: '#000000',
        addedAt: 1
      }
    ],
    activeRepoId: 'repo-1',
    activeWorktreeId: null,
    projects: [
      {
        id: 'repo-1',
        displayName: 'Repo',
        badgeColor: '#000000',
        sourceRepoIds: ['repo-1'],
        createdAt: 1,
        updatedAt: 1
      }
    ]
  }
}
