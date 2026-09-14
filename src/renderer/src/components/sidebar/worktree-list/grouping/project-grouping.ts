import type { Project, ProjectHostSetup } from '../../../../../../shared/project-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { RenderableFolderWorkspace } from './folder-workspace-lanes'
import { toSshExecutionHostId } from '../../../../../../shared/execution-host'
import { parseWslUncPath } from '../../../../../../shared/wsl-paths'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison
} from '../../../../../../shared/cross-platform-path'

export type OrderedGroupEntry = [string, WorktreeGroupEntry]

export type ProjectGroupingModel = {
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
}

export type WorktreeGroupEntry = {
  label: string
  items: Worktree[]
  repo?: Repo
  repoIds: Set<string>
  /** Folder workspaces bucketed into this lane under non-repo grouping. Carries
   *  the owning group because FolderWorkspaceRow requires a non-optional one. */
  folderWorkspaces?: RenderableFolderWorkspace[]
}

export type ProjectGroupingIndex = {
  projectById: Map<string, Project>
  setupByRepoId: Map<string, ProjectHostSetup>
  surfaceKeysRequiringSetupGroups: Set<string>
}

const projectGroupingIndexCache = new WeakMap<ProjectGroupingModel, ProjectGroupingIndex | null>()

// Why: provisioned and folder setups are not independent Git checkouts.
function isDistinctUserCheckout(setup: ProjectHostSetup): boolean {
  return setup.setupMethod !== 'provisioned' && setup.kind !== 'folder'
}

// Why: execution target and filesystem namespace independently identify a surface.
function getProjectSetupSurfaceKey(setup: ProjectHostSetup): string {
  return `${setup.projectId}::${setup.hostId}::${getExecutionSurface(setup)}::${getPathSurface(setup)}`
}

function getExecutionSurface(setup: ProjectHostSetup): string {
  const connectionId = setup.connectionId?.trim()
  if (connectionId) {
    return toSshExecutionHostId(connectionId)
  }
  return setup.executionHostId?.trim() || setup.hostId
}

// Why: projection twins differ by row identity, not checkout directory.
function getCheckoutIdentity(setup: ProjectHostSetup): string {
  return normalizeRuntimePathForComparison(setup.path.trim()) || setup.repoId || setup.id
}

function getPathSurface(setup: ProjectHostSetup): string {
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
  model?: ProjectGroupingModel
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
  const index = {
    projectById: new Map(projects.map((project) => [project.id, project])),
    setupByRepoId: new Map(projectHostSetups.map((setup) => [setup.repoId, setup])),
    surfaceKeysRequiringSetupGroups
  }
  projectGroupingIndexCache.set(model, index)
  return index
}

export type ProjectHeaderRevealTarget = {
  key: string
  label: string
  repo?: Repo
  projectId?: string
}

export function getProjectGroupingForRepo(
  repoId: string,
  repoMap: Map<string, Repo>,
  projectIndex: ProjectGroupingIndex | null
): ProjectHeaderRevealTarget {
  const repo = repoMap.get(repoId)
  const setup = projectIndex?.setupByRepoId.get(repoId)
  const project = setup ? projectIndex?.projectById.get(setup.projectId) : undefined
  if (!setup || !project) {
    return {
      key: `repo:${repoId}`,
      label: repo?.displayName ?? 'Unknown',
      repo
    }
  }
  if (
    projectIndex?.surfaceKeysRequiringSetupGroups.has(getProjectSetupSurfaceKey(setup)) &&
    isDistinctUserCheckout(setup)
  ) {
    // Why: only the ambiguous surface needs checkout-specific headers.
    return {
      key: `project:${project.id}::setup:${repoId}`,
      label: repo?.displayName ?? setup.displayName,
      repo,
      projectId: project.id
    }
  }
  // Why: provisioned runtime copies and non-ambiguous checkouts follow project
  // identity rather than path-scoped setup identity, so they stay in one project.
  return {
    key: `project:${project.id}`,
    label: project.displayName,
    repo,
    projectId: project.id
  }
}

export function getProjectHeaderRevealTarget(
  repoId: string,
  repoMap: Map<string, Repo>,
  projectGrouping?: ProjectGroupingModel
): ProjectHeaderRevealTarget {
  return getProjectGroupingForRepo(repoId, repoMap, buildProjectGroupingIndex(projectGrouping))
}

export function addRepoIdToGroup(group: WorktreeGroupEntry, repoId: string): void {
  group.repoIds.add(repoId)
}
