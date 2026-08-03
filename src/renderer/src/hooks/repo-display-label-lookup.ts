import { useCallback, useMemo } from 'react'
import {
  getRepoDisplayLabelKey,
  getRepoDisplayLabelsByPath,
  type RepoDisplayLabelItem
} from '@/lib/repo-display-labels'
import { useExecutionHostDisplayLabels } from './execution-host-display-labels'

/**
 * Resolves a repo to the disambiguated project label the sidebar's own group
 * headers show. Pass the full repo list, not a filtered/search subset, so a
 * label doesn't collapse back to the ambiguous name as rows drop out.
 */
export function useRepoDisplayLabel(
  repos: readonly RepoDisplayLabelItem[]
): (repo: RepoDisplayLabelItem) => string {
  const hostLabelById = useExecutionHostDisplayLabels()
  const labelsByKey = useMemo(
    () => getRepoDisplayLabelsByPath(repos, hostLabelById),
    [hostLabelById, repos]
  )
  return useCallback(
    (repo: RepoDisplayLabelItem) =>
      labelsByKey.get(getRepoDisplayLabelKey(repo)) ?? repo.displayName,
    [labelsByKey]
  )
}
