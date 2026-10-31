import type { ProjectPreference } from './personal-project-order'
import {
  projectPreferenceKeyForSetup,
  resolveProjectPreferenceKey
} from './project-preference-identity'
import { getRepoExecutionHostId, type ExecutionHostId } from './execution-host'
import { orderProjectSections, type ActivityItem } from './project-section-order'
import type { ProjectOrderBy } from './ui-chrome-types'
import type { Repo } from './repo-types'
import {
  buildProjectGroupingIndex,
  isCheckoutScopedProjectSetup,
  type ProjectGroupingIndex,
  type ProjectGroupingModel
} from './project-grouping-index'
export { buildProjectGroupingIndex, isCheckoutScopedProjectSetup } from './project-grouping-index'
export type {
  ProjectGroupingIndex,
  ProjectGroupingModel,
  ProjectSectionModel,
  ProjectSectionProject,
  ProjectSectionSetup
} from './project-grouping-index'

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
  projectPreferenceKey?: string
  projectPreference?: ProjectPreference
  items: Item[]
  /** Owning-project activity, when display placement files rows under another project. */
  activityItems?: readonly Item[]
  repo?: R
  repoIds: Set<string>
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
  projectIndex: ProjectGroupingIndex | null,
  ownerRepo?: R & ProjectSectionRepo
): ProjectHeaderRevealTarget<R> {
  const repo = ownerRepo ?? repoMap.get(repoId)
  const ownerHost = ownerRepo ? getRepoExecutionHostId(ownerRepo) : undefined
  const setup = ownerHost
    ? projectIndex?.setupByRepoHostId.get(JSON.stringify([ownerHost, repoId]))
    : projectIndex?.setupByRepoId.get(repoId)
  const project = setup ? projectIndex?.projectById.get(setup.projectId) : undefined
  if (!setup || !project) {
    return {
      key: `repo:${repoId}`,
      label: repo?.displayName ?? 'Unknown',
      repo
    }
  }
  if (projectIndex?.hostLocalCollisionIds.has(project.id)) {
    return {
      key: `project:${projectPreferenceKeyForSetup(setup)}`,
      label: repo?.displayName ?? setup.displayName,
      repo,
      projectId: project.id
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
  // Provisioned copies and unambiguous checkouts share project identity rather than path-scoped setup identity.
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
  repoOfItem?: (item: Item) => R | undefined
  repoMap: ReadonlyMap<string, R>
  projectIndex: ProjectGroupingIndex | null
}): Map<string, { items: Item[]; repoIds: Set<string> }> {
  const ownership = new Map<string, { items: Item[]; repoIds: Set<string> }>()
  for (const item of args.items) {
    const repoId = args.repoIdOf(item)
    const key = getProjectGroupingForRepo(
      repoId,
      args.repoMap,
      args.projectIndex,
      args.repoOfItem?.(item)
    ).key
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
  projectIndex: ProjectGroupingIndex | null,
  ownerRepo?: R
): void {
  const grouping = getProjectGroupingForRepo(repoId, repoMap, projectIndex, ownerRepo)
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
  repoOfItem?: (item: Item) => R | undefined
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
      projectIndex,
      args.displayRepoIdOf && args.displayRepoIdOf(item) !== repoId
        ? undefined
        : args.repoOfItem?.(item)
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
    if (projectIndex?.personalProjectOrder) {
      const preferenceKey = section.repo
        ? resolveProjectPreferenceKey(
            section.repo.id,
            projectIndex.projectHostSetups,
            getRepoExecutionHostId(section.repo)
          )
        : null
      section.projectPreferenceKey = preferenceKey ?? undefined
      section.projectPreference = preferenceKey
        ? (projectIndex.personalProjectOrder.projects[preferenceKey] ?? {})
        : {}
    }
  }
  return orderProjectSections(sections, repoMap, args.repoOrder, args.projectOrderBy)
}
