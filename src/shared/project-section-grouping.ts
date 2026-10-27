// The desktop sidebar's Project sections; the paired phone calls these same functions.
import type { ExecutionHostId } from './execution-host'
import { orderProjectSections, type ActivityItem } from './project-section-order'
import type { ProjectOrderBy } from './ui-chrome-types'
import type { Project, ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'

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
  const index = {
    projectById: new Map(projects.map((project) => [project.id, project])),
    setupByRepoId: new Map(projectHostSetups.map((setup) => [setup.repoId, setup]))
  }
  projectGroupingIndexCache.set(model, index)
  return index
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

/** Open empty repo sections; requireRepo skips missing catalog IDs instead of showing Unknown. */
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

/** Build unlabelled sections: rows, placeholders, notice repos (with catalog fallback), then pending workspace repos.
 * Header order is applied here; withRepoSectionDisplayLabels supplies labels. */
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
  // Repos may precede scans; ignore stale placeholder IDs instead of rendering Unknown headers.
  for (const repoId of args.placeholderRepoIds) {
    ensureProjectSectionForRepo(sections, repoId, repoMap, projectIndex, { requireRepo: true })
  }
  // Pinned worktrees leave natural groups, but actionable notices still need project sections.
  for (const [repoId, fallbackRepo] of args.noticeRepos ?? []) {
    ensureProjectSectionForRepo(sections, repoId, repoMap, projectIndex, { fallbackRepo })
  }
  // Ensure a section for first-workspace creation so its pending row is not dropped.
  for (const repoId of args.pendingRepoIds ?? []) {
    ensureProjectSectionForRepo(sections, repoId, repoMap, projectIndex)
  }
  for (const [key, section] of sections) {
    section.activityItems = ownership.get(key)?.items ?? []
  }
  return orderProjectSections(sections, repoMap, args.repoOrder, args.projectOrderBy)
}
