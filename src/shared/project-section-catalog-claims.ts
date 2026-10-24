import type { ServedProjectSections } from './project-section-catalog-schema'
import { getOutclaimedProjectSetups } from './project-checkout-claim'
import { getRepoSetupOwnerScope } from './repo-host-identity'
import { getRepoExecutionHostId } from './execution-host'

/** Old publishers advertise association without the remote metadata used by full hydration. */
export function resolveServedProjectSectionClaims(
  catalog: ServedProjectSections
): ServedProjectSections {
  const addedAtByOwner = new Map(
    catalog.repos.map((repo) => [
      `${getRepoSetupOwnerScope({ ...repo, hostId: getRepoExecutionHostId(repo) })}\0${repo.id}`,
      Number.isFinite(repo.addedAt) ? repo.addedAt! : 0
    ])
  )
  const claims = catalog.setups.map((setup) => ({
    ...setup,
    createdAt:
      addedAtByOwner.get(`${getRepoSetupOwnerScope(setup)}\0${setup.repoId}`) ??
      Number.POSITIVE_INFINITY
  }))
  const outclaimed = getOutclaimedProjectSetups(claims)
  if (!outclaimed.size) {
    return catalog
  }
  const projects = new Map(catalog.projects.map((project) => [project.id, project]))
  const setups = catalog.setups.map((setup, index) => {
    if (!outclaimed.has(claims[index]!)) {
      return setup
    }
    const projectId = `repo:${setup.repoId}`
    if (!projects.has(projectId)) {
      projects.set(projectId, { id: projectId, displayName: setup.displayName })
    }
    return { ...setup, projectId }
  })
  const occupied = new Set(setups.map((setup) => setup.projectId))
  return { ...catalog, projects: [...projects.values()].filter((p) => occupied.has(p.id)), setups }
}
