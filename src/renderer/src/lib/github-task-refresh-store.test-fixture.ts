import { createTestStore } from '@/store/slices/store-test-helpers'
import { vi } from 'vitest'
import { repo, source, key, projectKey, seed, table } from './github-task-refresh-data.test-fixture'

export function createTaskRefreshStore(n = 1) {
  const others = Array.from({ length: n - 1 }, (_, i) => ({
    ...seed,
    id: `issue:${i + 10}`,
    number: i + 10,
    url: `https://github.com/o/r/issues/${i + 10}`
  }))
  const twin = {
    ...seed,
    id: 'issue:5',
    url: 'https://github.com/upstream/r/issues/5',
    title: 'Twin'
  }
  const store = createTestStore()
  store.setState({
    repos: [repo],
    settings: null,
    projects: [],
    projectHostSetups: [],
    runtimeStatusByEnvironmentId: new Map(),
    taskPageData: {
      ...store.getState().taskPageData,
      openGitHubWorkItem: seed,
      openGitHubSourceContext: source
    },
    githubTaskDrawerWorkItem: seed,
    recordFeatureInteraction: vi.fn(),
    workItemsCache: {
      [key]: { data: [{ ...seed, id: 'issue:5' }, twin, ...others], fetchedAt: 10 }
    },
    projectViewCache: {
      [projectKey]: { data: table, fetchedAt: 20 },
      [projectKey.replace('view', 'view2')]: { data: table, fetchedAt: 30 }
    }
  })
  const pages = [null, null, [{ ...seed, id: 'issue:5' }, twin, ...others]]
  return { store, pages, others, twin }
}
