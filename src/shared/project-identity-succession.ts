import { getRepoExecutionHostId } from './execution-host'
import type { Project, ProjectHostSetup } from './project-types'
import { getRepoSetupOwnerScope } from './repo-host-identity'

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

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Carries persisted per-project user state (and the rows that point at it) across a
 * project id change. Project ids are derived from repo identity, so `repo:` -> `git:` ->
 * `github:` promotion and remote re-probes rewrite them mid-session; matching only on id
 * would drop the user's runtime preference and leave a ghost row behind.
 *
 * Association remapping stays one-to-one; preference continuity follows concrete owners.
 */
export function carryProjectStateThroughIdentityChange(
  projectedProjects: readonly Project[],
  previousProjects: readonly Project[],
  membership?: { previous: readonly ProjectHostSetup[]; current: readonly ProjectHostSetup[] }
): ProjectIdentitySuccession {
  const previousById = new Map(previousProjects.map((project) => [project.id, project]))
  const projectedIds = new Set(projectedProjects.map((project) => project.id))
  // Why: a prior row that still exists under its own id is live, not a predecessor.
  const orphanedPrevious = previousProjects.filter((project) => !projectedIds.has(project.id))
  const unmatched = projectedProjects.filter((project) => !previousById.has(project.id))
  const previousIndicesByRepo = new Map<string, number[]>()
  if (unmatched.length > 0) {
    orphanedPrevious.forEach((previous, index) => {
      for (const repoId of previous.sourceRepoIds) {
        const indices = previousIndicesByRepo.get(repoId)
        if (indices) {
          indices.push(index)
        } else {
          previousIndicesByRepo.set(repoId, [index])
        }
      }
    })
  }
  const candidates = unmatched.flatMap((project) => {
    const overlaps = new Map<number, number>()
    for (const repoId of new Set(project.sourceRepoIds)) {
      for (const index of previousIndicesByRepo.get(repoId) ?? []) {
        overlaps.set(index, (overlaps.get(index) ?? 0) + 1)
      }
    }
    // Preserve input order when the candidate comparator ties on legacy duplicate IDs.
    return [...overlaps]
      .sort(([left], [right]) => left - right)
      .map(([index, shared]) => ({
        project,
        previous: orphanedPrevious[index],
        shared
      }))
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
  if (membership) {
    const ownerKey = (setup: ProjectHostSetup) =>
      `${getRepoSetupOwnerScope(setup)}\0${setup.repoId}`
    const currentByOwner = new Map<string, Set<string>>()
    for (const setup of membership.current) {
      if (!setup.repoId) {
        continue
      }
      const key = ownerKey(setup)
      const ids = currentByOwner.get(key) ?? new Set<string>()
      ids.add(setup.projectId)
      currentByOwner.set(key, ids)
    }
    const successors = new Map<string, Set<string>>()
    for (const setup of membership.previous) {
      if (projectedIds.has(setup.projectId) || !setup.repoId) {
        continue
      }
      const ids = successors.get(setup.projectId) ?? new Set<string>()
      for (const id of currentByOwner.get(ownerKey(setup)) ?? []) {
        ids.add(id)
      }
      successors.set(setup.projectId, ids)
    }
    for (const [previousId, ids] of successors) {
      remappedProjectIds.delete(previousId)
      if (ids.size === 1) {
        remappedProjectIds.set(previousId, [...ids][0]!)
      }
    }
    const local = (setup: ProjectHostSetup) =>
      setup.hostId === 'local' && getRepoExecutionHostId(setup) === 'local'
    const previousByRepo = new Map<string, Project>()
    const recordedRepoIds = new Set(membership.previous.map((setup) => setup.repoId))
    for (const previous of previousProjects) {
      for (const repoId of previous.sourceRepoIds) {
        if (!recordedRepoIds.has(repoId)) {
          previousByRepo.set(repoId, previous)
        }
      }
    }
    for (const setup of membership.previous) {
      if (!local(setup)) {
        continue
      }
      const previous = previousById.get(setup.projectId)
      if (previous) {
        previousByRepo.set(setup.repoId, previous)
      }
    }
    const predecessors = new Map<string, Set<Project>>()
    for (const setup of membership.current) {
      if (!local(setup)) {
        continue
      }
      const previous = previousByRepo.get(setup.repoId)
      if (!previous) {
        continue
      }
      const owners = predecessors.get(setup.projectId) ?? new Set<Project>()
      owners.add(previous)
      predecessors.set(setup.projectId, owners)
    }
    for (const [index, project] of projects.entries()) {
      const owners = predecessors.get(project.id)
      // Only an unambiguous surviving local owner can carry a preference.
      if (owners?.size !== 1) {
        continue
      }
      const previous = [...owners][0]!
      const inherited = { ...carryUserState(project, previous) }
      if (!previous.localWindowsRuntimePreference) {
        delete inherited.localWindowsRuntimePreference
      }
      projects[index] = inherited
    }
  }
  return { projects, remappedProjectIds }
}
