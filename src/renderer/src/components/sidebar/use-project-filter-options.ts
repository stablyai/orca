import { isWebClientLocation } from '@/lib/web-client-location'
import { PROJECT_REPO_FILTER_EXACT_CAPABILITY } from '../../../../shared/project-repo-filter-capability'
import { buildProjectGroupingIndex } from '../../../../shared/project-section-grouping'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getProjectGroupingIndexFromState } from '@/store/project-host-setup-selector'
import {
  getProjectRepoFilterHost,
  projectFilterSelection,
  editProjectFilter
} from '../../../../shared/project-repo-filter-selection'

export function useProjectFilterOptions(filterRepoIds: readonly string[], pairingLocal = false) {
  const repos = useAppStore((s) => s.repos)
  const ownerSnapshot = useAppStore((s) =>
    isWebClientLocation() && !pairingLocal && s.runtimeEnvironments.length === 1
      ? s.runtimeStatusByEnvironmentId.get(s.runtimeEnvironments[0].id)?.snapshot
      : undefined
  )
  const remote = isWebClientLocation() && !pairingLocal
  const readable =
    ownerSnapshot?.verification === 'verified' &&
    ownerSnapshot.transport === 'ready' &&
    !ownerSnapshot.retired
  const legacy =
    remote &&
    ownerSnapshot?.status !== null &&
    ownerSnapshot?.status !== undefined &&
    !ownerSnapshot.status.capabilities?.includes(PROJECT_REPO_FILTER_EXACT_CAPABILITY)
  const catalogIndex = useAppStore(getProjectGroupingIndexFromState)
  const legacyIndex = useMemo(() => {
    if (!legacy) {
      return null
    }
    const projection = projectHostSetupProjectionFromRepos(repos)
    return buildProjectGroupingIndex({
      projects: repos.map((repo) => ({ id: repo.id, displayName: repo.displayName })),
      projectHostSetups: projection.setups.map((setup) => ({
        ...setup,
        projectId: setup.repoId,
        groupKey: setup.repoId
      }))
    })
  }, [repos, legacy])
  const index = legacyIndex ?? catalogIndex
  const groupedRepos = useMemo(() => {
    const byIdentity = new Map(
      repos.map((repo) => [`${getProjectRepoFilterHost(repo)}\0${repo.id}`, repo])
    )
    return index.groups.flatMap((group) => {
      const repo = byIdentity.get(
        `${getProjectRepoFilterHost(group.representative)}\0${group.representative.repoId}`
      )
      return repo ? [{ ...repo, id: group.key, displayName: group.label }] : []
    })
  }, [repos, index])
  const selection = useMemo(() => {
    if (!legacy) {
      return projectFilterSelection(index, filterRepoIds)
    }
    const raw = projectFilterSelection(
      index,
      filterRepoIds.filter((id) => !id.includes('\0'))
    )
    return {
      ...raw,
      active: filterRepoIds.length > 0,
      unresolved: [...raw.unresolved, ...filterRepoIds.filter((id) => id.includes('\0'))],
      badgeCount: filterRepoIds.length ? Math.max(1, raw.matchingKeys.length) : 0
    }
  }, [index, filterRepoIds, legacy])
  return {
    ready: !remote || readable,
    repos: groupedRepos,
    selection,
    edit: (kind: 'complete' | 'remove', keys: readonly string[]) => {
      if (!legacy) {
        return editProjectFilter(index, filterRepoIds, { kind, keys })
      }
      const touched = new Set(keys)
      return [
        ...new Set([
          ...filterRepoIds.filter((id) => !touched.has(id)),
          ...(kind === 'complete' ? keys : [])
        ])
      ]
    }
  }
}
