import type { ProjectGroupingIndex } from '../../../../shared/project-section-grouping'
import {
  editProjectFilter,
  getProjectRepoFilterHost
} from '../../../../shared/project-repo-filter-selection'
import { getRepoHostIdentityForParts } from '../../../../shared/repo-host-identity'
import { projectRepoFilterMatcher } from '../../../../shared/project-grouping'
export type ProjectFilterRevealState = {
  filterRepoIds: readonly string[]
  setFilterRepoIds: (repoIds: readonly string[]) => void
}

export function revealRepoInProjectFilter(
  state: ProjectFilterRevealState,
  repoId: string,
  hostId = 'local',
  index?: ProjectGroupingIndex
): void {
  // Why: an empty allow-list disables filtering, so adding one id would narrow the unfiltered view.
  if (
    state.filterRepoIds.length === 0 ||
    projectRepoFilterMatcher(state.filterRepoIds)(repoId, hostId)
  ) {
    return
  }
  const group = index?.groups.find((candidate) =>
    candidate.registrations.some(
      (setup) => setup.repoId === repoId && getProjectRepoFilterHost(setup) === hostId
    )
  )
  if (index && group) {
    state.setFilterRepoIds(
      editProjectFilter(index, state.filterRepoIds, { kind: 'complete', keys: [group.key] })
    )
  } else {
    state.setFilterRepoIds([...state.filterRepoIds, getRepoHostIdentityForParts(repoId, hostId)])
  }
}
