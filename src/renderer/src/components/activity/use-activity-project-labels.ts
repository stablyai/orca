import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getProjectHostSetupProjectionFromState } from '@/store/project-host-setup-selector'
import { getActivityProjectLabelsByRepoId } from './activity-thread-grouping'

export function useActivityProjectLabels(): ReadonlyMap<string, string> {
  const repos = useAppStore((s) => s.repos)
  const projectCatalog = useAppStore(getProjectHostSetupProjectionFromState)
  return useMemo(
    () =>
      getActivityProjectLabelsByRepoId(repos, {
        projects: projectCatalog.projects,
        projectHostSetups: projectCatalog.setups
      }),
    [repos, projectCatalog]
  )
}
