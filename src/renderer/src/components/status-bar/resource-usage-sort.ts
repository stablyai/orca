import type { Metric, UnifiedProjectGroup, UnifiedWorktreeRow } from './resource-usage-merge-types'

export type ResourceUsageSortOption = 'memory' | 'cpu' | 'name'

function compareMetricDesc(left: Metric, right: Metric): number {
  // Why: remote null metrics stay behind sampled rows for every sort direction.
  if (left === null && right === null) {
    return 0
  }
  if (left === null) {
    return 1
  }
  if (right === null) {
    return -1
  }
  return right - left
}

export function sortResourceUsageWorktrees(
  list: UnifiedWorktreeRow[],
  sort: ResourceUsageSortOption
): UnifiedWorktreeRow[] {
  const copy = [...list]
  if (sort === 'memory') {
    copy.sort((left, right) => compareMetricDesc(left.memory, right.memory))
  } else if (sort === 'cpu') {
    copy.sort((left, right) => compareMetricDesc(left.cpu, right.cpu))
  } else {
    copy.sort((left, right) => left.worktreeName.localeCompare(right.worktreeName))
  }
  return copy
}

export function sortResourceUsageProjectGroups(
  groups: UnifiedProjectGroup[],
  sort: ResourceUsageSortOption
): UnifiedProjectGroup[] {
  const copy = [...groups]
  if (sort === 'memory') {
    copy.sort((left, right) => compareMetricDesc(left.memory, right.memory))
  } else if (sort === 'cpu') {
    copy.sort((left, right) => compareMetricDesc(left.cpu, right.cpu))
  } else {
    copy.sort((left, right) => left.repoName.localeCompare(right.repoName))
  }
  return copy
}
