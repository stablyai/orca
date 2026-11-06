import { useMemo } from 'react'
import type { HostScopedRepoKey } from '../../../../../shared/repository/repo-host-identity'
import { useAppStore } from '@/store'
import { getProjectHostSetupProjectionFromState } from '@/store/projects/project-host-setup-selector'
import { getActivityProjectLabelsByRepoHost } from './activity-thread-grouping'

export function useActivityProjectLabels(): ReadonlyMap<HostScopedRepoKey, string> {
  const repos = useAppStore((s) => s.repos)
  const projectCatalog = useAppStore(getProjectHostSetupProjectionFromState)
  return useMemo(
    () =>
      getActivityProjectLabelsByRepoHost(repos, {
        projects: projectCatalog.projects,
        projectHostSetups: projectCatalog.setups
      }),
    [repos, projectCatalog]
  )
}
