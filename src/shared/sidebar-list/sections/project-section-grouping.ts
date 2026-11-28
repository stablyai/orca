// The desktop sidebar's Project sections; the paired phone calls these same functions.
import type { ProjectOrderBy } from '../../ui-chrome/ui-chrome-types'
import { orderProjectSections, type ActivityItem } from './project-section-order'
import {
  buildProjectGroupingIndex,
  getProjectGroupingForRepo,
  getProjectHeaderRevealTarget,
  isCheckoutScopedProjectSetup,
  type ProjectGroupingIndex,
  type ProjectGroupingModel,
  type ProjectHeaderRevealTarget,
  type ProjectSectionEntry,
  type ProjectSectionModel,
  type ProjectSectionProject,
  type ProjectSectionRepo,
  type ProjectSectionSetup
} from './project-grouping-index'

export {
  buildProjectGroupingIndex,
  getProjectGroupingForRepo,
  getProjectHeaderRevealTarget,
  isCheckoutScopedProjectSetup,
  type ProjectGroupingIndex,
  type ProjectGroupingModel,
  type ProjectHeaderRevealTarget,
  type ProjectSectionEntry,
  type ProjectSectionModel,
  type ProjectSectionProject,
  type ProjectSectionRepo,
  type ProjectSectionSetup
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
    let entry = ownership.get(key)
    if (!entry) {
      entry = { items: [], repoIds: new Set<string>() }
      ownership.set(key, entry)
    }
    entry.items.push(item)
    entry.repoIds.add(repoId)
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
  let anyRehomed = false
  for (let i = 0; i < args.items.length; i += 1) {
    const item = args.items[i]
    const repoId = args.repoIdOf(item)
    const displayRepoId = args.displayRepoIdOf ? args.displayRepoIdOf(item) : repoId
    if (displayRepoId !== repoId) {
      anyRehomed = true
    }
    addItemToProjectSection(sections, item, displayRepoId, repoMap, projectIndex)
  }
  // Repos may precede scans; ignore stale placeholder IDs instead of rendering Unknown headers.
  for (const repoId of args.placeholderRepoIds) {
    ensureProjectSectionForRepo(sections, repoId, repoMap, projectIndex, { requireRepo: true })
  }
  // Pinned worktrees leave natural groups, but actionable notices still need project sections.
  if (args.noticeRepos) {
    for (const [repoId, fallbackRepo] of args.noticeRepos) {
      ensureProjectSectionForRepo(sections, repoId, repoMap, projectIndex, { fallbackRepo })
    }
  }
  // Ensure a section for first-workspace creation so its pending row is not dropped.
  if (args.pendingRepoIds) {
    for (const repoId of args.pendingRepoIds) {
      ensureProjectSectionForRepo(sections, repoId, repoMap, projectIndex)
    }
  }
  if (anyRehomed) {
    const ownership = buildProjectOwnershipIndex(args)
    for (const [key, section] of sections) {
      section.activityItems = ownership.get(key)?.items ?? []
    }
  } else {
    for (const section of sections.values()) {
      section.activityItems = section.items
    }
  }
  return orderProjectSections(sections, repoMap, args.repoOrder, args.projectOrderBy)
}
