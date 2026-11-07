import { getProjectGroupingForRepo } from './project-section-reveal'
import { getRepoExecutionHostId } from './execution-host'
import { getRepoHostIdentityForParts } from './repo-host-identity'
import type {
  ProjectSectionRepo,
  ProjectSectionEntry,
  ProjectGroupingIndex
} from './project-section-grouping'

export function retainSectionDisplayRepo<R extends ProjectSectionRepo>(
  section: ProjectSectionEntry<unknown, R>,
  repo: R | undefined,
  order: ReadonlyMap<string, number> | undefined
): void {
  if (
    repo &&
    (!section.displayRepo ||
      (order?.get(repo.id) ?? Infinity) < (order?.get(section.displayRepo.id) ?? Infinity))
  ) {
    section.displayRepo = repo
  }
}

export function addItemToProjectSection<Item, R extends ProjectSectionRepo>(
  sections: Map<string, ProjectSectionEntry<Item, R>>,
  item: Item,
  repoId: string,
  repoMap: ReadonlyMap<string, R>,
  projectIndex: ProjectGroupingIndex | null,
  hostId?: string,
  repoByHost?: ReadonlyMap<string, R>,
  repoOrder?: ReadonlyMap<string, number>
): void {
  const grouping = getProjectGroupingForRepo(repoId, repoMap, projectIndex, hostId, repoByHost)
  let section = sections.get(grouping.key)
  if (!section) {
    section = {
      label: grouping.label,
      items: [],
      repo: grouping.repo,
      displayRepo: grouping.repo,
      repoIds: new Set()
    }
    sections.set(grouping.key, section)
  }
  retainSectionDisplayRepo(section, grouping.repo, repoOrder)
  section.items.push(item)
  section.repoIds.add(repoId)
}

/** Open empty repo sections; requireRepo skips missing catalog IDs instead of showing Unknown. */
export function ensureProjectSectionForRepo<Item, R extends ProjectSectionRepo, Notice>(
  sections: Map<string, ProjectSectionEntry<Item, R, Notice>>,
  repoId: string,
  repoMap: ReadonlyMap<string, R>,
  projectIndex: ProjectGroupingIndex | null,
  options: {
    requireRepo?: boolean
    fallbackRepo?: R
    repoByHost?: ReadonlyMap<string, R>
    repoOrder?: ReadonlyMap<string, number>
  } = {}
): ProjectSectionEntry<Item, R, Notice> | undefined {
  const grouping = getProjectGroupingForRepo(
    repoId,
    repoMap,
    projectIndex,
    options.fallbackRepo ? getRepoExecutionHostId(options.fallbackRepo) : undefined,
    options.repoByHost
  )
  const separator = repoId.indexOf('\0')
  const rawId = separator === -1 ? repoId : repoId.slice(separator + 1)
  const hostId = options.fallbackRepo
    ? getRepoExecutionHostId(options.fallbackRepo)
    : separator !== -1
      ? repoId.slice(0, separator)
      : grouping.repo
        ? getRepoExecutionHostId(grouping.repo)
        : undefined
  const owner = hostId
    ? projectIndex?.groupByRepoHost.get(getRepoHostIdentityForParts(rawId, hostId))
    : undefined
  if (owner && owner.key !== grouping.key) {
    return undefined
  }
  if (options.requireRepo && !grouping.repo) {
    return
  }
  repoId = grouping.repo?.id ?? repoId.slice(repoId.indexOf('\0') + 1)
  const section = sections.get(grouping.key)
  if (section) {
    retainSectionDisplayRepo(section, grouping.repo ?? options.fallbackRepo, options.repoOrder)
    section.repoIds.add(repoId)
    return section
  }
  const created: ProjectSectionEntry<Item, R, Notice> = {
    label: grouping.label,
    items: [],
    repo: grouping.repo ?? options.fallbackRepo,
    displayRepo: grouping.repo ?? options.fallbackRepo,
    repoIds: new Set([repoId])
  }
  sections.set(grouping.key, created)
  return created
}
