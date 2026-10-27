import type { AppState } from '@/store'

export function directWorkItemCatalogFixture() {
  return {
    repos: [
      {
        id: 'repo-1',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: '#000000',
        addedAt: 1
      }
    ] satisfies AppState['repos'],
    activeRepoId: 'repo-1',
    activeWorktreeId: null,
    endpointProjectHostSetups: [
      {
        id: 'repo-1',
        projectId: 'repo-1',
        repoId: 'repo-1',
        path: '/repo',
        displayName: 'Repo',
        hostId: 'local',
        setupState: 'ready',
        setupMethod: 'legacy-repo',
        createdAt: 1,
        updatedAt: 1
      }
    ] satisfies AppState['endpointProjectHostSetups'],
    endpointProjects: [
      {
        id: 'repo-1',
        displayName: 'Repo',
        badgeColor: '#000000',
        sourceRepoIds: ['repo-1'],
        createdAt: 1,
        updatedAt: 1
      }
    ] satisfies AppState['endpointProjects']
  }
}
