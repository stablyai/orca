import type { Repo } from '../../../../../shared/repo-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { parseTaskQuery, type ParsedTaskQuery } from '../../../../../shared/task-query'
import { getTaskPageRepoSourceContext } from '../task-page-source-context'
import {
  captureGitHubTaskObservation,
  getGitHubTaskObservation,
  type GitHubTaskObservation
} from '@/lib/github-task-observation'
import { getGitHubRepoLookupIndex } from '@/store/slices/github-repo-lookup-index'
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
    item: Pick<GitHubWorkItem, 'repoId' | 'repoHostId'> & {
      githubObservation?: GitHubTaskObservation
    }
  ) => GitHubTaskObservation | undefined
  owns?: (owner: GitHubTaskObservation | undefined) => boolean
}
export function createTaskPageGitHubProjectionContext(
  repos: readonly Repo[],
  query: ParsedTaskQuery,
  queryKey: string,
  viewerLogin: string | null
): TaskPageGitHubProjectionContext {
  const lookup = getGitHubRepoLookupIndex(repos)
  // Finish the shared lookup before any queued row can consult it.
  lookup.findForWorkItem({ repoId: '' })
  const owners = new Map(
    repos.map((repo) => [
      repo,
      captureGitHubTaskObservation(repo, getTaskPageRepoSourceContext(repo, 'github'))
    ])
  )
  const keys = new Set([...owners.values()].map((owner) => owner?.key))
  return {
    query: { ...query, labels: [...query.labels] },
    queryKey,
    viewerLogin,
    owns: (owner) => !owner || owner.aliases.some((key) => keys.has(key)),
    ownerOf: (item) => {
      const hostId = item.repoHostId ?? item.githubObservation?.hostId
      const candidate = hostId
        ? lookup.findByHostAndId(hostId, item.repoId)
        : lookup.findById(item.repoId)
      const repo = hostId || candidate === lookup.findForWorkItem(item) ? candidate : undefined
      return repo ? owners.get(repo) : undefined
    }
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
  const ownerOf = context.ownerOf
  const compose = createTaskPageGitHubAuthorityProjection()
  const project = createTaskPageGitHubMembershipProjection(context)
  return (networkItems: readonly GitHubWorkItem[], previousItems: readonly GitHubWorkItem[]) => {
    const byKey = new Map<string, GitHubWorkItem>()
    for (const item of networkItems) {
      const owner = ownerOf?.(item) ?? getGitHubTaskObservation(item)
      const scope = owner ? githubTaskSourceKey(owner.source) : null
      byKey.set(taskPageGitHubObservedRowKey(item), compose(item, scope, owner))
    }
    for (const item of previousItems) {
      const key = taskPageGitHubObservedRowKey(item)
      if (byKey.has(key)) {
        continue
      }
      const owner = ownerOf?.(item) ?? getGitHubTaskObservation(item)
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
