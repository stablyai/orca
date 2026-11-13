import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getProjectHostSetupProjectionFromState } from '@/store/projects/project-host-setup-selector'
import type { HostScopedRepoKey } from '../../../../shared/repo-host-identity'
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
