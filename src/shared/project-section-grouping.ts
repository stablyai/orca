import {
  addItemToProjectSection,
  ensureProjectSectionForRepo,
  retainSectionDisplayRepo
} from './project-section-collection'
import {
  getProjectGroupingForRepo,
  getProjectSectionRepoLookup,
  type ProjectHeaderRevealTarget
} from './project-section-reveal'
export {
  getProjectGroupingForRepo,
  getProjectSectionRepoLookup,
  type ProjectHeaderRevealTarget
} from './project-section-reveal'
import { getRepoExecutionHostId } from './execution-host'
// The desktop sidebar's Project sections; the paired phone calls these same functions.
import type { ExecutionHostId } from './execution-host'
import { orderProjectSections, type ActivityItem } from './project-section-order'
import type { ProjectOrderBy } from './ui-chrome-types'
import {
  buildProjectGroups,
  type ProjectGroupingSettings,
  type CheckoutProjectGroup,
  type GroupingSetup
} from './project-grouping'
import type { Project, ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'
import { projectHostSetupProjectionFromRepos } from './project-host-setup-projection'
import { getRepoHostIdentityForParts } from './repo-host-identity'

/** The project fields grouping reads. */
export type ProjectSectionProject = Pick<Project, 'id' | 'displayName'>

/** The host-setup fields grouping and host labels read. */
export type ProjectSectionSetup = GroupingSetup

export type ProjectGroupingModel = {
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
  settings?: ProjectGroupingSettings | null
}

/** What grouping reads of a model; a paired phone receives only this much. */
export type ProjectSectionModel = {
  projects: readonly ProjectSectionProject[]
  projectHostSetups: readonly ProjectSectionSetup[]
  settings?: ProjectGroupingSettings | null
}

export type ProjectGroupingIndex = {
  groups: CheckoutProjectGroup[]
  groupByKey: ReadonlyMap<string, CheckoutProjectGroup>
  projectById: Map<string, ProjectSectionProject>
  setupByRepoId: Map<string, ProjectSectionSetup>
  groupByRepoId: Map<string, CheckoutProjectGroup>
  groupByRepoHost: Map<string, CheckoutProjectGroup>
  setupByRepoHost: Map<string, ProjectSectionSetup>
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
export type ProjectSectionEntry<Item, R extends ProjectSectionRepo = Repo, Notice = unknown> = {
  noticeRefs?: Notice[]
  pendingBucketRefs?: string[]
  label: string
  items: Item[]
  /** Owning-project activity, when display placement files rows under another project. */
  activityItems?: readonly Item[]
  repo?: R
  /** Validated section-owned display source; raw ordering anchors never fill it. */
  displayRepo?: R
  repoIds: Set<string>
}

const indexCache = new WeakMap<
  ProjectSectionModel,
  { groups: CheckoutProjectGroup[]; index: ProjectGroupingIndex }
>()

export function buildProjectGroupingIndex(model: ProjectSectionModel): ProjectGroupingIndex
export function buildProjectGroupingIndex(model?: ProjectSectionModel): ProjectGroupingIndex | null
export function buildProjectGroupingIndex(
  model?: ProjectSectionModel
): ProjectGroupingIndex | null {
  if (!model) {
    return null
  }
  const groups = buildProjectGroups(model)
  const cached = indexCache.get(model)
  if (cached?.groups === groups) {
    return cached.index
  }
  const index: ProjectGroupingIndex = {
    groups,
    groupByKey: new Map(groups.map((group) => [group.key, group])),
    projectById: new Map(model.projects.map((project) => [project.id, project])),
    setupByRepoHost: new Map(
      model.projectHostSetups.map((setup) => [`${setup.hostId}\0${setup.repoId}`, setup])
    ),
    groupByRepoHost: new Map(
      groups.flatMap((group) =>
        group.registrations.map((setup) => [`${setup.hostId}\0${setup.repoId}`, group] as const)
      )
    ),
    setupByRepoId: new Map(model.projectHostSetups.map((setup) => [setup.repoId, setup])),
    groupByRepoId: new Map(
      groups.flatMap((group) => group.registrations.map((setup) => [setup.repoId, group] as const))
    )
  }
  indexCache.set(model, { groups, index })
  return index
}

const repoModels = new WeakMap<readonly object[], ProjectGroupingModel>()

/** Catalog-less clients use the same grouping builder with their bundled repo projection. */
export function buildRepoProjectGroupingIndex(
  repos: readonly (ProjectSectionRepo & Partial<Repo>)[],
  settings?: ProjectGroupingSettings | null
): ProjectGroupingIndex {
  let model = repoModels.get(repos)
  if (
    !model ||
    model.settings?.projectGroupingMode !== settings?.projectGroupingMode ||
    model.settings?.projectGroupingOverrides !== settings?.projectGroupingOverrides
  ) {
    const projection = projectHostSetupProjectionFromRepos(
      repos.map((repo) => ({ badgeColor: '', addedAt: 0, ...repo }))
    )
    model = { projects: projection.projects, projectHostSetups: projection.setups, settings }
    repoModels.set(repos, model)
  }
  return buildProjectGroupingIndex(model)
}

export function getProjectGroupForRepo(
  index: ProjectGroupingIndex,
  repo: Pick<Repo, 'id'> & Partial<Repo>
): CheckoutProjectGroup | undefined {
  return index.groupByRepoHost.get(
    getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo))
  )
}

export function getProjectHeaderRevealTarget(
  repoId: string,
  repoMap: Map<string, Repo>,
  projectGrouping?: ProjectGroupingModel,
  hostId?: string
): ProjectHeaderRevealTarget {
  return getProjectGroupingForRepo(
    repoId,
    repoMap,
    buildProjectGroupingIndex(projectGrouping),
    hostId
  )
}

/** Actual membership, independent of where a lineage occurrence is displayed. */
export function buildProjectOwnershipIndex<Item, R extends ProjectSectionRepo>(args: {
  items: readonly Item[]
  repoIdOf: (item: Item) => string
  hostIdOf?: (item: Item) => string | undefined
  repoMap: ReadonlyMap<string, R>
  projectIndex: ProjectGroupingIndex | null
  repoByHost?: ReadonlyMap<string, R>
}): Map<string, { items: Item[]; repoIds: Set<string> }> {
  const ownership = new Map<string, { items: Item[]; repoIds: Set<string> }>()
  for (const item of args.items) {
    const repoId = args.repoIdOf(item)
    const key = getProjectGroupingForRepo(
      repoId,
      args.repoMap,
      args.projectIndex,
      args.hostIdOf?.(item),
      args.repoByHost
    ).key
    const entry = ownership.get(key) ?? { items: [], repoIds: new Set<string>() }
    entry.items.push(item)
    entry.repoIds.add(repoId)
    ownership.set(key, entry)
  }
  return ownership
}

/** Build unlabelled sections: rows, placeholders, notice repos (with catalog fallback), then pending workspace repos.
 * Header order is applied here; withRepoSectionDisplayLabels supplies labels. */
export function buildProjectSections<
  Item extends ActivityItem,
  R extends ProjectSectionRepo,
  Notice = unknown
>(args: {
  items: readonly Item[]
  repoIdOf: (item: Item) => string
  hostIdOf?: (item: Item) => string | undefined
  displayRepoIdOf?: (item: Item) => string
  repoMap: ReadonlyMap<string, R>
  projectIndex: ProjectGroupingIndex | null
  repos?: readonly R[]
  placeholderRepoIds: Iterable<string>
  noticeRepos?: Iterable<readonly [string, R | undefined, Notice?]>
  pendingRepoIds?: Iterable<string>
  repoOrder: ReadonlyMap<string, number> | undefined
  projectOrderBy: ProjectOrderBy
}): [string, ProjectSectionEntry<Item, R, Notice>][] {
  const { repoMap, projectIndex } = args
  const sections = new Map<string, ProjectSectionEntry<Item, R, Notice>>()
  const repoByHost = args.repos ? getProjectSectionRepoLookup(args.repos) : undefined
  const ownership = buildProjectOwnershipIndex({ ...args, repoByHost })
  for (const item of args.items) {
    const repoId = args.repoIdOf(item)
    addItemToProjectSection(
      sections,
      item,
      args.displayRepoIdOf?.(item) ?? repoId,
      repoMap,
      projectIndex,
      args.hostIdOf?.(item),
      repoByHost,
      args.repoOrder
    )
  }
  // Repos may precede scans; ignore stale placeholder IDs instead of rendering Unknown headers.
  for (const repoId of args.placeholderRepoIds) {
    ensureProjectSectionForRepo(sections, repoId, repoMap, projectIndex, {
      requireRepo: true,
      repoByHost,
      repoOrder: args.repoOrder
    })
  }
  // Pinned worktrees leave natural groups, but actionable notices still need project sections.
  for (const [repoId, fallbackRepo, ref] of args.noticeRepos ?? []) {
    const section = ensureProjectSectionForRepo(sections, repoId, repoMap, projectIndex, {
      fallbackRepo,
      repoByHost,
      repoOrder: args.repoOrder
    })
    if (section && ref !== undefined) {
      ;(section.noticeRefs ??= []).push(ref)
    }
  }
  // Ensure a section for first-workspace creation so its pending row is not dropped.
  for (const repoId of args.pendingRepoIds ?? []) {
    const section = ensureProjectSectionForRepo(sections, repoId, repoMap, projectIndex, {
      repoByHost,
      repoOrder: args.repoOrder
    })
    if (section) {
      ;(section.pendingBucketRefs ??= []).push(repoId)
    }
  }
  for (const [key, section] of sections) {
    section.activityItems = ownership.get(key)?.items ?? []
    for (const setup of projectIndex?.groupByKey.get(key)?.registrations ?? []) {
      const raw = repoMap.get(setup.repoId)
      const own =
        repoByHost?.get(`${setup.hostId}\0${setup.repoId}`) ??
        (raw && getRepoExecutionHostId(raw) === setup.hostId ? raw : undefined)
      retainSectionDisplayRepo(section, own, args.repoOrder)
    }
  }
  return orderProjectSections(sections, repoMap, args.repoOrder, args.projectOrderBy)
}
