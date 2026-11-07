import type { PersonalProjectOrder } from './personal-project-order'
import { projectPreferenceKeyForSetup } from './project-preference-identity'
import { toSshExecutionHostId } from './execution-host'
import type { Project, ProjectHostSetup } from './project-types'
import { parseWslUncPath } from './wsl-paths'
import { isWindowsAbsolutePathLike, normalizeRuntimePathForComparison } from './cross-platform-path'

/** The project fields grouping reads. */
export type ProjectSectionProject = Pick<Project, 'id' | 'displayName'>

/** The host-setup fields grouping and host labels read. */
export type ProjectSectionSetup = Pick<
  ProjectHostSetup,
  'id' | 'projectId' | 'hostId' | 'repoId' | 'path' | 'displayName' | 'setupMethod'
> &
  Partial<Pick<ProjectHostSetup, 'kind' | 'connectionId' | 'executionHostId'>>

export type ProjectGroupingModel = {
  personalProjectOrder?: PersonalProjectOrder
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
}

/** What grouping reads of a model; a paired phone receives only this much. */
export type ProjectSectionModel = {
  personalProjectOrder?: PersonalProjectOrder
  projects: readonly ProjectSectionProject[]
  projectHostSetups: readonly ProjectSectionSetup[]
}

export type ProjectGroupingIndex = {
  personalProjectOrder?: PersonalProjectOrder
  projectHostSetups: readonly ProjectSectionSetup[]
  hostLocalCollisionIds: ReadonlySet<string>
  projectById: Map<string, ProjectSectionProject>
  setupByRepoId: Map<string, ProjectSectionSetup>
  setupByRepoHostId: Map<string, ProjectSectionSetup>
  surfaceKeysRequiringSetupGroups: Set<string>
}

const projectGroupingIndexCache = new WeakMap<ProjectSectionModel, ProjectGroupingIndex | null>()

// Why: provisioned and folder setups are not independent Git checkouts.
function isDistinctUserCheckout(setup: ProjectSectionSetup): boolean {
  return setup.setupMethod !== 'provisioned' && setup.kind !== 'folder'
}

// Why: execution target and filesystem namespace independently identify a surface.
function getProjectSetupSurfaceKey(setup: ProjectSectionSetup): string {
  return `${setup.projectId}::${setup.hostId}::${getExecutionSurface(setup)}::${getPathSurface(setup)}`
}

function getExecutionSurface(setup: ProjectSectionSetup): string {
  const connectionId = setup.connectionId?.trim()
  if (connectionId) {
    return toSshExecutionHostId(connectionId)
  }
  return setup.executionHostId?.trim() || setup.hostId
}

// Why: projection twins differ by row identity, not checkout directory.
function getCheckoutIdentity(setup: ProjectSectionSetup): string {
  return normalizeRuntimePathForComparison(setup.path.trim()) || setup.repoId || setup.id
}

function getPathSurface(setup: ProjectSectionSetup): string {
  const wslPath = parseWslUncPath(setup.path)
  if (wslPath) {
    return `wsl:${wslPath.distro.toLowerCase()}`
  }
  if (isWindowsAbsolutePathLike(setup.path)) {
    return 'windows-host'
  }
  return 'default'
}

export function buildProjectGroupingIndex(
  model?: ProjectSectionModel
): ProjectGroupingIndex | null {
  if (!model) {
    return null
  }
  const cached = projectGroupingIndexCache.get(model)
  if (cached !== undefined) {
    return cached
  }
  const projects = model.projects ?? []
  const projectHostSetups = model.projectHostSetups ?? []
  if ((projects.length === 0 || projectHostSetups.length === 0) && !model.personalProjectOrder) {
    projectGroupingIndexCache.set(model, null)
    return null
  }
  const checkoutsByProjectSurface = new Map<string, Set<string>>()
  for (const setup of projectHostSetups) {
    if (!isDistinctUserCheckout(setup)) {
      continue
    }
    const key = getProjectSetupSurfaceKey(setup)
    const existing = checkoutsByProjectSurface.get(key)
    if (existing) {
      existing.add(getCheckoutIdentity(setup))
    } else {
      checkoutsByProjectSurface.set(key, new Set([getCheckoutIdentity(setup)]))
    }
  }
  const surfaceKeysRequiringSetupGroups = new Set<string>()
  for (const [surfaceKey, checkouts] of checkoutsByProjectSurface) {
    if (checkouts.size > 1) {
      surfaceKeysRequiringSetupGroups.add(surfaceKey)
    }
  }
  const firstHostKeyByProject = new Map<string, string>()
  const hostLocalCollisionIds = new Set<string>()
  for (const setup of projectHostSetups) {
    if (!setup.projectId.startsWith('repo:')) {
      continue
    }
    const key = projectPreferenceKeyForSetup(setup)
    const previous = firstHostKeyByProject.get(setup.projectId)
    if (previous !== undefined && previous !== key) {
      hostLocalCollisionIds.add(setup.projectId)
    }
    firstHostKeyByProject.set(setup.projectId, key)
  }
  const index = {
    personalProjectOrder: model.personalProjectOrder,
    projectHostSetups,
    hostLocalCollisionIds,
    projectById: new Map(projects.map((project) => [project.id, project])),
    setupByRepoHostId: new Map(
      projectHostSetups.map((setup) => [JSON.stringify([setup.hostId, setup.repoId]), setup])
    ),
    setupByRepoId: new Map(projectHostSetups.map((setup) => [setup.repoId, setup])),
    surfaceKeysRequiringSetupGroups
  }
  projectGroupingIndexCache.set(model, index)
  return index
}

// Why: Settings splits projects by this same rule so it matches the sidebar headers.
export function isCheckoutScopedProjectSetup(
  setup: ProjectSectionSetup,
  projectIndex: ProjectGroupingIndex
): boolean {
  return (
    projectIndex.surfaceKeysRequiringSetupGroups.has(getProjectSetupSurfaceKey(setup)) &&
    isDistinctUserCheckout(setup)
  )
}
