import { describe, expect, it } from 'vitest'
import { mergeFetchedRepoCatalog } from '../repos/repo-catalog-merge'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { Repo } from '../../../../shared/repo-types'
import { registerReposCatalogMergeIdentityTests } from './repos-catalog-merge-identity.spec'
import { registerReposRefreshIdentityTests } from './repos-refresh-identity.spec'
import { registerReposCatalogNotificationsTests } from './repos-catalog-notifications.spec'
import { registerReposStaleFetchTests } from './repos-stale-fetch.spec'
import { registerReposSharedProjectBadgeColorTests } from './repos-shared-project-badge-color.spec'
import { registerReposAllHostsFolderWorkspacesTests } from './repos-all-hosts-folder-workspaces.spec'
import { registerReposRuntimeVisibilityDefaultsTests } from './repos-runtime-visibility-defaults.spec'

describe('repos-catalog-merge-identity', registerReposCatalogMergeIdentityTests)
describe('repos-refresh-identity', registerReposRefreshIdentityTests)
describe('repos-catalog-notifications', registerReposCatalogNotificationsTests)
describe('repos-stale-fetch', registerReposStaleFetchTests)
describe('repos-shared-project-badge-color', registerReposSharedProjectBadgeColorTests)
describe('repos-all-hosts-folder-workspaces', registerReposAllHostsFolderWorkspacesTests)
describe('repos-runtime-visibility-defaults', registerReposRuntimeVisibilityDefaultsTests)

// No remote metadata yet: only the hydrated catalog knows these registrations share a project.
it.each(['repository', 'host', 'folder'] as const)(
  'inherits user groups through hydrated membership in %s mode',
  (projectGroupingMode) => {
    const previous: Repo[] = [
      {
        id: 'local',
        path: '/local/app',
        displayName: 'App',
        badgeColor: '',
        addedAt: 0,
        projectGroupId: 'team'
      }
    ]
    const fetched: Repo[] = [
      {
        id: 'remote',
        path: '/remote/app',
        displayName: 'App',
        badgeColor: '',
        addedAt: 0,
        executionHostId: 'runtime:server'
      }
    ]
    const savedProjection = (repos: Repo[]) => {
      const projection = projectHostSetupProjectionFromRepos(repos)
      return {
        projects: [
          {
            ...projection.projects[0],
            id: 'saved-project',
            sourceRepoIds: repos.map((repo) => repo.id)
          }
        ],
        setups: projection.setups.map((setup) => ({ ...setup, projectId: 'saved-project' }))
      }
    }
    const local = savedProjection(previous)
    const result = mergeFetchedRepoCatalog(
      {
        repos: fetched,
        projectHostSetupCompatibility: savedProjection(fetched),
        hostId: 'runtime:server',
        reposAtRequest: previous
      },
      previous,
      { projectGroupingMode },
      { projects: local.projects, projectHostSetups: local.setups }
    )
    expect(result.repos.find((repo) => repo.id === 'remote')?.projectGroupId).toBe(
      projectGroupingMode === 'repository' ? 'team' : undefined
    )
    expect(previous[0].projectGroupId).toBe('team')
  }
)
