import { createStore } from 'zustand'
import { vi } from 'vitest'
import type { AppState } from '@/store/types'
import { createGitHubSlice } from '@/store/slices/github'
import { createRuntimeStatusSlice } from '@/store/slices/runtime-status'
import { createRepoUpdateActions } from '@/store/repos/repo-update'
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
  const store = createStore<AppState>()(
    (...args) =>
      ({
        ...createGitHubSlice(...args),
        ...createRuntimeStatusSlice(...args),
        ...createRepoUpdateActions(args[0], args[1]),
        repos: [repo],
        settings: null,
        endpointProjects: [],
        endpointProjectHostSetups: [],
        projects: [],
        projectHostSetups: [],
        runtimeStatusByEnvironmentId: new Map(),
        taskPageData: { openGitHubWorkItem: seed, openGitHubSourceContext: source },
        githubTaskDrawerWorkItem: seed,
        recordFeatureInteraction: vi.fn(),
        recordFeatureInteractionOnce: vi.fn(),
        workItemsCache: {
          [key]: { data: [{ ...seed, id: 'issue:5' }, twin, ...others], fetchedAt: 10 }
        },
        projectViewCache: {
          [projectKey]: { data: table, fetchedAt: 20 },
          [projectKey.replace('view', 'view2')]: { data: table, fetchedAt: 30 }
        }
      }) as AppState
  ) // SAFETY: only selected Task/Project fields and real GitHub slice actions are exercised.
  const pages = [null, null, [{ ...seed, id: 'issue:5' }, twin, ...others]]
  return { store, pages, others, twin }
}
