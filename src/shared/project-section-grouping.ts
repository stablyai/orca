// The desktop sidebar's Project sections; the paired phone calls these same functions.
import type { ExecutionHostId } from './execution-host'
import { orderProjectSections, type ActivityItem } from './project-section-order'
import type { ProjectOrderBy } from './ui-chrome-types'
import { toSshExecutionHostId } from './execution-host'
import type { Project, ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'
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
  const index = {
    projectById: new Map(projects.map((project) => [project.id, project])),
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

export type ProjectHeaderRevealTarget<R extends Pick<ProjectSectionRepo, 'displayName'> = Repo> = {
  key: string
  label: string
  repo?: R
  projectId?: string
}

export function getProjectGroupingForRepo<R extends Pick<ProjectSectionRepo, 'displayName'>>(
  repoId: string,
  repoMap: ReadonlyMap<string, R>,
  projectIndex: ProjectGroupingIndex | null
): ProjectHeaderRevealTarget<R> {
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
  if (projectIndex && isCheckoutScopedProjectSetup(setup, projectIndex)) {
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

/** Actual membership, independent of where a lineage occurrence is displayed. */
export function buildProjectOwnershipIndex<Item, R extends ProjectSectionRepo>(args: {
  items: readonly Item[]
  repoIdOf: (item: Item) => string
  repoMap: ReadonlyMap<string, R>
  projectIndex: ProjectGroupingIndex | null
}): Map<string, { items: Item[]; repoIds: Set<string> }> {
  const ownership = new Map<string, { items: Item[]; repoIds: Set<string> }>()
  for (const item of args.items) {
    const repoId = args.repoIdOf(item)
    const key = getProjectGroupingForRepo(repoId, args.repoMap, args.projectIndex).key
    const entry = ownership.get(key) ?? { items: [], repoIds: new Set<string>() }
    entry.items.push(item)
    entry.repoIds.add(repoId)
    ownership.set(key, entry)
  }
  return ownership
}

/** Files `item` under its displayed project section. */
function addItemToProjectSection<Item, R extends ProjectSectionRepo>(
  sections: Map<string, ProjectSectionEntry<Item, R>>,
  item: Item,
  repoId: string,
  repoMap: ReadonlyMap<string, R>,
  projectIndex: ProjectGroupingIndex | null
): void {
  const grouping = getProjectGroupingForRepo(repoId, repoMap, projectIndex)
  let section = sections.get(grouping.key)
  if (!section) {
    section = { label: grouping.label, items: [], repo: grouping.repo, repoIds: new Set() }
    sections.set(grouping.key, section)
  }
  section.items.push(item)
  section.repoIds.add(repoId)
}

/**
 * Opens the project section for a repo that has no rows to file, or joins the repo to the open one.
 * `requireRepo` skips repo ids missing from the catalog, which would otherwise read "Unknown".
 */
function ensureProjectSectionForRepo<Item, R extends ProjectSectionRepo>(
  sections: Map<string, ProjectSectionEntry<Item, R>>,
  repoId: string,
  repoMap: ReadonlyMap<string, R>,
  projectIndex: ProjectGroupingIndex | null,
  options: { requireRepo?: boolean; fallbackRepo?: R } = {}
): void {
  const grouping = getProjectGroupingForRepo(repoId, repoMap, projectIndex)
  if (options.requireRepo && !grouping.repo) {
    return
  }
  const section = sections.get(grouping.key)
  if (section) {
    section.repoIds.add(repoId)
    return
  }
  sections.set(grouping.key, {
    label: grouping.label,
    items: [],
    repo: grouping.repo ?? options.fallbackRepo,
    repoIds: new Set([repoId])
  })
}

/**
 * Project sections in header order, unlabelled (see withRepoSectionDisplayLabels): rows first, then
 * empty-project placeholders, notice rows' repos (opened with the notice's own repo if the catalog
 * lacks it), and repos with a workspace being created.
 */
export function buildProjectSections<
  Item extends ActivityItem,
  R extends ProjectSectionRepo
>(args: {
  items: readonly Item[]
  repoIdOf: (item: Item) => string
  displayRepoIdOf?: (item: Item) => string
  repoMap: ReadonlyMap<string, R>
  projectIndex: ProjectGroupingIndex | null
  placeholderRepoIds: Iterable<string>
  noticeRepos?: Iterable<readonly [string, R | undefined]>
  pendingRepoIds?: Iterable<string>
  repoOrder: ReadonlyMap<string, number> | undefined
  projectOrderBy: ProjectOrderBy
}): [string, ProjectSectionEntry<Item, R>][] {
  const { repoMap, projectIndex } = args
  const sections = new Map<string, ProjectSectionEntry<Item, R>>()
  const ownership = buildProjectOwnershipIndex(args)
  for (const item of args.items) {
    const repoId = args.repoIdOf(item)
    addItemToProjectSection(
      sections,
      item,
      args.displayRepoIdOf?.(item) ?? repoId,
      repoMap,
      projectIndex
    )
  }
  // Why: repos can arrive before worktree scans, but stale IDs passed by
  // older snapshots must not render an "Unknown" project header.
  for (const repoId of args.placeholderRepoIds) {
    ensureProjectSectionForRepo(sections, repoId, repoMap, projectIndex, { requireRepo: true })
  }
  // Why: the default policy removes pinned worktrees from natural groups,
  // but actionable notice rows still need a project section to render in.
  for (const [repoId, fallbackRepo] of args.noticeRepos ?? []) {
    ensureProjectSectionForRepo(sections, repoId, repoMap, projectIndex, { fallbackRepo })
  }
  // Why: creating the first worktree in a repo leaves it with no group yet;
  // ensure one so the in-progress row nests under its repo instead of being dropped.
  for (const repoId of args.pendingRepoIds ?? []) {
    ensureProjectSectionForRepo(sections, repoId, repoMap, projectIndex)
  }
  for (const [key, section] of sections) {
    section.activityItems = ownership.get(key)?.items ?? []
  }
  return orderProjectSections(sections, repoMap, args.repoOrder, args.projectOrderBy)
}
