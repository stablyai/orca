import type { Project } from './types'

export type ProjectIdentitySuccession = {
  /** Projected projects with user-set state carried forward from their predecessor row. */
  projects: readonly Project[]
  /** Predecessor project id -> surviving project id, for rows whose identity key changed. */
  remappedProjectIds: ReadonlyMap<string, string>
}

function carryUserState(projected: Project, previous: Project): Project {
  return previous.localWindowsRuntimePreference
    ? {
        ...projected,
        localWindowsRuntimePreference: previous.localWindowsRuntimePreference,
        updatedAt: Math.max(projected.updatedAt, previous.updatedAt)
      }
    : projected
}

function countSharedRepoIds(sourceRepoIds: readonly string[], other: ReadonlySet<string>): number {
  return sourceRepoIds.reduce((count, repoId) => (other.has(repoId) ? count + 1 : count), 0)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Carries persisted per-project user state (and the rows that point at it) across a
 * project id change. Project ids are derived from repo identity, so `repo:` -> `git:` ->
 * `github:` promotion and remote re-probes rewrite them mid-session; matching only on id
 * would drop the user's runtime preference and leave a ghost row behind.
 *
 * Predecessor rule when several prior rows overlap a surviving project: most shared
 * `sourceRepoIds` wins, then newest `updatedAt`, then lowest prior id (then lowest new id).
 * Each prior row is claimed by at most one surviving project, so two distinct user
 * preferences are never merged into one — the unclaimed row keeps its own identity.
 */
export function carryProjectStateThroughIdentityChange(
  projectedProjects: readonly Project[],
  previousProjects: readonly Project[]
): ProjectIdentitySuccession {
  const previousById = new Map(previousProjects.map((project) => [project.id, project]))
  const projectedIds = new Set(projectedProjects.map((project) => project.id))
  // Why: a prior row that still exists under its own id is live, not a predecessor.
  const orphanedPrevious = previousProjects.filter((project) => !projectedIds.has(project.id))
  const unmatched = projectedProjects.filter((project) => !previousById.has(project.id))
  const candidates = unmatched.flatMap((project) => {
    const repoIds = new Set(project.sourceRepoIds)
    return orphanedPrevious
      .map((previous) => ({
        project,
        previous,
        shared: countSharedRepoIds(previous.sourceRepoIds, repoIds)
      }))
      .filter((candidate) => candidate.shared > 0)
  })
  candidates.sort(
    (left, right) =>
      right.shared - left.shared ||
      right.previous.updatedAt - left.previous.updatedAt ||
      compareStrings(left.previous.id, right.previous.id) ||
      compareStrings(left.project.id, right.project.id)
  )
  const claimedPreviousIds = new Set<string>()
  const predecessorByProjectId = new Map<string, Project>()
  for (const candidate of candidates) {
    if (
      claimedPreviousIds.has(candidate.previous.id) ||
      predecessorByProjectId.has(candidate.project.id)
    ) {
      continue
    }
    claimedPreviousIds.add(candidate.previous.id)
    predecessorByProjectId.set(candidate.project.id, candidate.previous)
  }
  const remappedProjectIds = new Map<string, string>()
  const projects = projectedProjects.map((project) => {
    const exact = previousById.get(project.id)
    if (exact) {
      return carryUserState(project, exact)
    }
    const predecessor = predecessorByProjectId.get(project.id)
    if (!predecessor) {
      return project
    }
    remappedProjectIds.set(predecessor.id, project.id)
    return carryUserState(project, predecessor)
  })
  return { projects, remappedProjectIds }
}
