import type { ExecutionHostId } from '../../execution-host/execution-host'
import { toSshExecutionHostId } from '../../execution-host/execution-host'
import type { Project, ProjectHostSetup } from '../../project/project-types'
import type { Repo } from '../../repository/repo-types'
import { parseWslUncPath } from '../../file-access/wsl-paths'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison
} from '../../file-access/cross-platform-path'

/** The project fields grouping reads. */
export type ProjectSectionProject = Pick<Project, 'id' | 'displayName'>

/** The host-setup fields grouping and host labels read. */
export type ProjectSectionSetup = Pick<
  ProjectHostSetup,
  'id' | 'projectId' | 'hostId' | 'repoId' | 'path' | 'displayName' | 'setupMethod'
> &
  Partial<Pick<ProjectHostSetup, 'kind' | 'connectionId' | 'executionHostId'>>

export type ProjectGroupingModel = {
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
}

/** What grouping reads of a model; a paired phone receives only this much. */
export type ProjectSectionModel = {
  projects: readonly ProjectSectionProject[]
  projectHostSetups: readonly ProjectSectionSetup[]
}

export type ProjectGroupingIndex = {
  projectById: Map<string, ProjectSectionProject>
  setupByRepoId: Map<string, ProjectSectionSetup>
  surfaceKeysRequiringSetupGroups: Set<string>
}

/** The repo fields section grouping, labelling and ordering read. */
export type ProjectSectionRepo = {
  id: string
  displayName: string
  path: string
  addedAt?: number
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
}

/** One project section: its rows, the repo that anchors its header, and every repo it holds. */
export type ProjectSectionEntry<Item, R extends ProjectSectionRepo = Repo> = {
  label: string
  items: Item[]
  /** Owning-project activity, when display placement files rows under another project. */
  activityItems?: readonly Item[]
  repo?: R
  repoIds: Set<string>
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
  if (projects.length === 0 || projectHostSetups.length === 0) {
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
  const projectById = new Map<string, ProjectSectionProject>()
  for (let i = 0; i < projects.length; i += 1) {
    projectById.set(projects[i].id, projects[i])
  }
  const setupByRepoId = new Map<string, ProjectSectionSetup>()
  for (let i = 0; i < projectHostSetups.length; i += 1) {
    setupByRepoId.set(projectHostSetups[i].repoId, projectHostSetups[i])
  }
  const index = { projectById, setupByRepoId, surfaceKeysRequiringSetupGroups }
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

export type ProjectHeaderRevealTarget<R extends Pick<ProjectSectionRepo, 'displayName'> = Repo> = {
  key: string
  label: string
  repo?: R
  projectId?: string
}

const NULL_PROJECT_GROUPING_INDEX_KEY: object = {}
const projectGroupingForRepoCache = new WeakMap<
  ReadonlyMap<string, unknown>,
  WeakMap<object, Map<string, ProjectHeaderRevealTarget<Pick<ProjectSectionRepo, 'displayName'>>>>
>()

export function getProjectGroupingForRepo<R extends Pick<ProjectSectionRepo, 'displayName'>>(
  repoId: string,
  repoMap: ReadonlyMap<string, R>,
  projectIndex: ProjectGroupingIndex | null
): ProjectHeaderRevealTarget<R> {
  const repo = repoMap.get(repoId)
  const indexKey: object = projectIndex ?? NULL_PROJECT_GROUPING_INDEX_KEY
  let byIndex = projectGroupingForRepoCache.get(repoMap)
  let byRepoId = byIndex?.get(indexKey)
  const cached = byRepoId?.get(repoId)
  if (cached && cached.repo === repo) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cached under this exact repoMap whose values are R, and cached.repo === repo.
    return cached as ProjectHeaderRevealTarget<R>
  }
  const setup = projectIndex?.setupByRepoId.get(repoId)
  const project = setup ? projectIndex?.projectById.get(setup.projectId) : undefined
  let result: ProjectHeaderRevealTarget<R>
  if (!setup || !project) {
    result = {
      key: `repo:${repoId}`,
      label: repo?.displayName ?? 'Unknown',
      repo
    }
  } else if (projectIndex && isCheckoutScopedProjectSetup(setup, projectIndex)) {
    // Why: only the ambiguous surface needs checkout-specific headers.
    result = {
      key: `project:${project.id}::setup:${repoId}`,
      label: repo?.displayName ?? setup.displayName,
      repo,
      projectId: project.id
    }
  } else {
    // Provisioned copies and unambiguous checkouts share project identity rather than path-scoped setup identity.
    result = {
      key: `project:${project.id}`,
      label: project.displayName,
      repo,
      projectId: project.id
    }
  }
  if (!byIndex) {
    byIndex = new WeakMap()
    projectGroupingForRepoCache.set(repoMap, byIndex)
  }
  if (!byRepoId) {
    byRepoId = new Map()
    byIndex.set(indexKey, byRepoId)
  }
  byRepoId.set(repoId, result)
  return result
}

export function getProjectHeaderRevealTarget(
  repoId: string,
  repoMap: Map<string, Repo>,
  projectGrouping?: ProjectGroupingModel
): ProjectHeaderRevealTarget {
  return getProjectGroupingForRepo(repoId, repoMap, buildProjectGroupingIndex(projectGrouping))
}
