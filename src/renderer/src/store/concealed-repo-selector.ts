import { getConcealedRepoIds, withoutConcealedRepos } from '../../../shared/incognito-projects'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type { WorkspaceSpaceAnalysis } from '../../../shared/workspace-space-types'
import { retainWorkspaceSpaceRows } from './slices/workspace-space-analysis-rows'
import type { AppState } from './types'

type ConcealedRepoState = Pick<AppState, 'repos' | 'incognitoProjectsUnlocked'>

const lockedCache = new WeakMap<AppState['repos'], ReadonlySet<string>>()
const shownReposCache = new WeakMap<AppState['repos'], AppState['repos']>()

/** Stable per `repos` identity so selectors and memos keyed on it don't churn. */
export function getConcealedRepoIdsFromState(state: ConcealedRepoState): ReadonlySet<string> {
  if (state.incognitoProjectsUnlocked) {
    return getConcealedRepoIds(state.repos, true)
  }
  let concealed = lockedCache.get(state.repos)
  if (!concealed) {
    concealed = getConcealedRepoIds(state.repos, false)
    lockedCache.set(state.repos, concealed)
  }
  return concealed
}

/** `state.repos` minus locked incognito repos; the same array when nothing is concealed. */
export function getShownReposFromState(state: ConcealedRepoState): AppState['repos'] {
  const concealed = getConcealedRepoIdsFromState(state)
  if (concealed.size === 0) {
    return state.repos
  }
  let shown = shownReposCache.get(state.repos)
  if (!shown) {
    shown = withoutConcealedRepos(state.repos, concealed)
    shownReposCache.set(state.repos, shown)
  }
  return shown
}

/** Groups holding only concealed repos, directly or through child groups, would leak as empty headers. */
export function withoutConcealedOnlyProjectGroups(
  groups: readonly ProjectGroup[],
  repos: readonly Pick<Repo, 'id' | 'projectGroupId'>[],
  folderWorkspaces: readonly Pick<FolderWorkspace, 'projectGroupId'>[],
  concealedRepoIds: ReadonlySet<string>
): readonly ProjectGroup[] {
  if (concealedRepoIds.size === 0) {
    return groups
  }
  const groupsWithConcealed = new Set<string>()
  const groupsWithShown = new Set<string>()
  for (const repo of repos) {
    if (!repo.projectGroupId) {
      continue
    }
    if (concealedRepoIds.has(repo.id)) {
      groupsWithConcealed.add(repo.projectGroupId)
    } else {
      groupsWithShown.add(repo.projectGroupId)
    }
  }
  if (groupsWithConcealed.size === 0) {
    return groups
  }
  for (const folder of folderWorkspaces) {
    groupsWithShown.add(folder.projectGroupId)
  }
  const childIdsByParent = new Map<string, string[]>()
  for (const group of groups) {
    if (group.parentGroupId) {
      const siblings = childIdsByParent.get(group.parentGroupId) ?? []
      siblings.push(group.id)
      childIdsByParent.set(group.parentGroupId, siblings)
    }
  }
  const hiddenById = new Map<string, boolean>()
  // Why children first: a parent is hidden only when every child it would show is hidden too.
  const isHidden = (groupId: string, visiting: Set<string>): boolean => {
    const known = hiddenById.get(groupId)
    if (known !== undefined) {
      return known
    }
    if (visiting.has(groupId)) {
      return false
    }
    visiting.add(groupId)
    const children = childIdsByParent.get(groupId) ?? []
    const childHidden = children.map((childId) => isHidden(childId, visiting))
    visiting.delete(groupId)
    const hasConcealed = groupsWithConcealed.has(groupId) || childHidden.some(Boolean)
    const hasShown = groupsWithShown.has(groupId) || childHidden.some((hidden) => !hidden)
    const hidden = hasConcealed && !hasShown
    hiddenById.set(groupId, hidden)
    return hidden
  }
  const visible = groups.filter((group) => !isHidden(group.id, new Set()))
  return visible.length === groups.length ? groups : visible
}

/** Drops concealed repo keys from a repo-keyed record; the same record when nothing changes. */
export function omitConcealedRepoKeys<T>(
  byRepo: Record<string, T>,
  concealedRepoIds: ReadonlySet<string>
): Record<string, T> {
  if (concealedRepoIds.size === 0 || ![...concealedRepoIds].some((id) => id in byRepo)) {
    return byRepo
  }
  return Object.fromEntries(
    Object.entries(byRepo).filter(([repoId]) => !concealedRepoIds.has(repoId))
  )
}

const shownSpaceCache = new WeakMap<
  WorkspaceSpaceAnalysis,
  { concealed: ReadonlySet<string>; shown: WorkspaceSpaceAnalysis }
>()

/** The space analysis without locked incognito repos, so totals and counts never include them. */
export function getShownWorkspaceSpaceAnalysisFromState(
  state: ConcealedRepoState & Pick<AppState, 'workspaceSpaceAnalysis'>
): WorkspaceSpaceAnalysis | null {
  const analysis = state.workspaceSpaceAnalysis
  const concealed = getConcealedRepoIdsFromState(state)
  if (!analysis || concealed.size === 0) {
    return analysis
  }
  const cached = shownSpaceCache.get(analysis)
  if (cached?.concealed === concealed) {
    return cached.shown
  }
  const shown = retainWorkspaceSpaceRows(
    analysis,
    () => true,
    (repoId) => !concealed.has(repoId)
  )
  shownSpaceCache.set(analysis, { concealed, shown })
  return shown
}
