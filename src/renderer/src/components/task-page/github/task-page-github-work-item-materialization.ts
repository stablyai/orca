import type { Repo } from '../../../../../shared/repo-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { parseTaskQuery, type ParsedTaskQuery } from '../../../../../shared/task-query'
import { getTaskPageRepoSourceContext } from '../task-page-source-context'
import {
  createGitHubTaskObservationIndex,
  captureGitHubTaskObservation,
  getGitHubTaskObservation,
  type GitHubTaskObservation
} from '@/lib/github-task-observation'
import { githubTaskIdentity, githubTaskSourceKey } from '@/lib/github-task-target'
import { observeExistingListBases } from './task-page-github-work-item-mutation-registry'
import {
  createTaskPageGitHubAuthorityProjection,
  createTaskPageGitHubMembershipProjection,
  adoptTaskPageGitHubMembershipFamilies
} from './task-page-github-work-item-mutation-composition'

export type TaskPageGitHubProjectionContext = {
  query: ParsedTaskQuery
  queryKey: string
  viewerLogin: string | null
  ownerOf?: (
    item: Pick<GitHubWorkItem, 'repoId' | 'repoHostId'>
  ) => GitHubTaskObservation | undefined
  owns?: (owner: GitHubTaskObservation | undefined) => boolean
}
export function createTaskPageGitHubProjectionContext(
  repos: readonly Repo[],
  query: ParsedTaskQuery,
  queryKey: string,
  viewerLogin: string | null
): TaskPageGitHubProjectionContext {
  const keys = new Set(
    repos.map(
      (repo) =>
        captureGitHubTaskObservation(repo, getTaskPageRepoSourceContext(repo, 'github'))?.key
    )
  )
  return {
    query,
    queryKey,
    viewerLogin,
    owns: (owner) => !owner || owner.aliases.some((key) => keys.has(key)),
    ownerOf: createGitHubTaskObservationIndex(repos, (repo) =>
      getTaskPageRepoSourceContext(repo, 'github')
    )
  }
}
export function admitTaskPageGitHubListInputs(
  items: readonly GitHubWorkItem[],
  context?: TaskPageGitHubProjectionContext,
  fillOnly = false
): void {
  const current = items.filter((item) => {
    const owner = getGitHubTaskObservation(item)
    const actual = context?.ownerOf?.(item)
    return !!owner && (!context?.ownerOf || actual?.key === owner.key)
  })
  observeExistingListBases(current, fillOnly)
}
export function taskPageGitHubObservedRowKey(item: GitHubWorkItem): string {
  const owner = getGitHubTaskObservation(item)
  return JSON.stringify([
    owner?.key ?? item.repoHostId ?? null,
    item.repoId,
    githubTaskIdentity(item),
    item.id
  ])
}
export function materializeTaskPageItemList(args: {
  networkItems: readonly GitHubWorkItem[]
  previousItems: readonly GitHubWorkItem[]
  queryKey: string
  context?: TaskPageGitHubProjectionContext
}): GitHubWorkItem[] {
  const context = args.context ?? {
    query: parseTaskQuery(''),
    queryKey: args.queryKey,
    viewerLogin: null
  }
  for (const item of args.networkItems) {
    const owner = context.ownerOf?.(item) ?? getGitHubTaskObservation(item)
    adoptTaskPageGitHubMembershipFamilies(
      item,
      owner ? githubTaskSourceKey(owner.source) : null,
      args.queryKey,
      owner
    )
  }
  return createTaskPageGitHubMaterializer(context)(args.networkItems, args.previousItems)
}
export function createTaskPageGitHubMaterializer(context: TaskPageGitHubProjectionContext) {
  const compose = createTaskPageGitHubAuthorityProjection()
  const project = createTaskPageGitHubMembershipProjection(context)
  return (networkItems: readonly GitHubWorkItem[], previousItems: readonly GitHubWorkItem[]) => {
    const byKey = new Map<string, GitHubWorkItem>()
    for (const item of networkItems) {
      const owner = context.ownerOf?.(item) ?? getGitHubTaskObservation(item)
      const scope = owner ? githubTaskSourceKey(owner.source) : null
      byKey.set(taskPageGitHubObservedRowKey(item), compose(item, scope, owner))
    }
    for (const item of previousItems) {
      const key = taskPageGitHubObservedRowKey(item)
      if (byKey.has(key)) {
        continue
      }
      const owner = context.ownerOf?.(item) ?? getGitHubTaskObservation(item)
      const scope = owner ? githubTaskSourceKey(owner.source) : null
      const projected = project(item, scope, owner)
      if (
        compose.pending(item, scope, owner).length ||
        (projected.hide && projected.hasKnowledge)
      ) {
        byKey.set(key, projected.item)
      }
    }
    return [...byKey.values()].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
  }
}
