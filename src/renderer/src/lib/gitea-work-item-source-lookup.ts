import type {
  GiteaProjectRef,
  GiteaWorkItem,
  ListGiteaPullRequestsResult,
  PRListState
} from '../../../shared/gitea-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { parseGiteaWorkItemReference } from '../../../shared/new-workspace/gitea-links'
import { giteaApiFor } from '@/runtime/gitea-owner-api'

type GiteaSourceLookupArgs = {
  repoPath: string
  repoId: string
  sourceContext?: TaskSourceContext | null
  /** The repo's own host; routes to its server when no task source names one. */
  repoOwnerExecutionHostId?: string
}

type GiteaWorkItemByPathLookupArgs = GiteaSourceLookupArgs & {
  host: string
  path: string
  number: number
  type: 'issue' | 'pr'
}

type GiteaWorkItemListLookupArgs = GiteaSourceLookupArgs & {
  state?: PRListState
  page?: number
  perPage?: number
  query?: string
}

function withRendererRepoId(item: Omit<GiteaWorkItem, 'repoId'> | GiteaWorkItem, repoId: string) {
  return { ...item, repoId }
}

export async function lookupGiteaProjectSlugForSource(
  args: GiteaSourceLookupArgs
): Promise<GiteaProjectRef | null> {
  return giteaApiFor(args).projectSlug(args)
}

export async function lookupGiteaWorkItemByPathForSource(
  args: GiteaWorkItemByPathLookupArgs
): Promise<GiteaWorkItem | null> {
  const item = await giteaApiFor(args).workItemByPath(args)
  return item ? withRendererRepoId(item, args.repoId) : null
}

export async function listGiteaWorkItemsForSource(
  args: GiteaWorkItemListLookupArgs
): Promise<ListGiteaPullRequestsResult> {
  const result = await giteaApiFor(args).listWorkItems(args)
  return {
    ...result,
    items: result.items.map((item) => withRendererRepoId(item, args.repoId))
  }
}

/**
 * Resolve `#N`, `!N`, `owner/repo#N` and Gitea URLs to exact items, and any other text to a
 * work-item search on the repo's Gitea project.
 */
export async function resolveGiteaWorkItemsForQuery(
  args: GiteaWorkItemListLookupArgs
): Promise<GiteaWorkItem[]> {
  const reference = args.query ? parseGiteaWorkItemReference(args.query) : null
  if (!reference) {
    return (await listGiteaWorkItemsForSource(args)).items
  }
  let host = reference.host
  let path = reference.path
  if (!host || !path) {
    const slug = await lookupGiteaProjectSlugForSource(args)
    if (!slug) {
      return []
    }
    host = host ?? slug.host
    path = path ?? slug.path
  }
  const types: ('issue' | 'pr')[] = reference.type ? [reference.type] : ['issue', 'pr']
  const found = await Promise.all(
    types.map((type) =>
      lookupGiteaWorkItemByPathForSource({
        repoPath: args.repoPath,
        repoId: args.repoId,
        sourceContext: args.sourceContext,
        repoOwnerExecutionHostId: args.repoOwnerExecutionHostId,
        host,
        path,
        number: reference.number,
        type
      }).catch(() => null)
    )
  )
  return found.filter((item): item is GiteaWorkItem => item !== null)
}
