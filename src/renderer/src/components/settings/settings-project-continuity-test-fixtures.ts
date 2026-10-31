import type { Repo } from '../../../../shared/repo-types'
import {
  adoptEndpointRepo,
  adoptEndpointProjectCatalog
} from '../../../../shared/endpoint-catalog-adoption'
import { getProjectRepoFilterHost } from '../../../../shared/project-repo-filter-selection'
import { useAppStore } from '@/store'
import { getProjectGroupingModelFromState } from '@/store/project-host-setup-selector'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'

import { buildSettingsProjectList } from './settings-project-list'
export function nestedRemovalCatalog(
  mode: 'repository' | 'host' | 'folder' = 'host',
  author?: (repos: Repo[]) => void
) {
  const canonical: Repo[] = [
    {
      id: 'r',
      path: '/srv/r',
      displayName: 'Harbor X',
      badgeColor: '',
      addedAt: 0,
      connectionId: 'x',
      executionHostId: 'ssh:x',
      upstream: { owner: 'org', repo: 'harbor' }
    },
    {
      id: 'r',
      path: '/srv/r',
      displayName: 'Harbor Y',
      badgeColor: '',
      addedAt: 0,
      connectionId: 'y',
      executionHostId: 'ssh:y',
      upstream: { owner: 'org', repo: 'harbor' }
    },
    {
      id: 'q',
      path: '/srv/q',
      displayName: 'Harbor Q',
      badgeColor: '',
      addedAt: 0,
      connectionId: 'y',
      executionHostId: 'ssh:y',
      upstream: { owner: 'org', repo: 'harbor' }
    }
  ]
  author?.(canonical)
  const projected = projectHostSetupProjectionFromRepos(canonical)
  const target = { kind: 'environment', environmentId: 'E' } as const
  const catalog = adoptEndpointProjectCatalog(target, projected.projects, projected.setups)
  const repos = canonical.map((repo) => adoptEndpointRepo(target, repo))
  useAppStore.setState({
    repos,
    projects: catalog.projects,
    projectHostSetups: catalog.setups,
    settings: { ...getDefaultSettings('/tmp'), projectGroupingMode: mode },
    sshTargetLabels: new Map([
      ['x', 'WRONG LOCAL X'],
      ['y', 'WRONG LOCAL Y']
    ]),
    sshStateByEnvironment: new Map([
      [
        'E',
        {
          targetLabels: new Map([
            ['x', 'Build X'],
            ['y', 'Build Y']
          ]),
          connectionStates: new Map(),
          targetGenerations: new Map(),
          removedTargetLabels: new Map(),
          targetsHydrated: true
        }
      ]
    ])
  })
  const entries = buildSettingsProjectList(
    repos,
    getProjectGroupingModelFromState(useAppStore.getState())
  )
  const x = entries.find((entry) =>
    entry.setups.some((setup) => getProjectRepoFilterHost(setup) === 'ssh:x')
  )!
  const y = entries.find(
    (entry) => entry !== x && entry.setups.some((setup) => setup.repoId === 'r')
  )
  return { canonical, repos, catalog, entries, x, y }
}
