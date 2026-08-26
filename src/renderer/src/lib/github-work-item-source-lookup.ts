import type { GitHubWorkItem, GitHubWorkItemDetails } from '../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { withDerivedPullRequestQueueState } from '../../../shared/github/pull-request-queue-state'
import {
  getGitHubRuntimeRepoId,
  getGitHubSourceRuntimeHost,
  getGitHubSourceRuntimeTarget
} from './github-source-runtime-context'

type GitHubWorkItemLookupArgs = {
  repoPath: string
  repoId: string
  sourceContext?: TaskSourceContext | null
  number: number
  type?: 'issue' | 'pr'
}

type GitHubWorkItemByOwnerRepoLookupArgs = GitHubWorkItemLookupArgs & {
  owner: string
  repo: string
  host?: string
  type: 'issue' | 'pr'
}

type GitHubWorkItemDetailsLookupArgs = {
  repoPath: string
  repoId: string
  sourceContext?: TaskSourceContext | null
  number: number
  type: 'issue' | 'pr'
}

function runtimeRepoId(args: Pick<GitHubWorkItemLookupArgs, 'repoId' | 'sourceContext'>): string {
  return getGitHubRuntimeRepoId(args.sourceContext, args.repoId)
}

export async function lookupGitHubWorkItemForSource(
  args: GitHubWorkItemLookupArgs
): Promise<GitHubWorkItem | null> {
  const target = getGitHubSourceRuntimeTarget(args.sourceContext)
  const item =
    target.kind === 'environment'
      ? await callRuntimeRpc<Omit<GitHubWorkItem, 'repoId'> | null>(
          target,
          'github.workItem',
          {
            repo: runtimeRepoId(args),
            number: args.number,
            type: args.type
          },
          { timeoutMs: 30_000 }
        )
      : await window.api.gh.workItem({
          repoPath: args.repoPath,
          repoId: args.repoId,
          number: args.number,
          type: args.type
        })
  // Why: the wire carries `open` + `mergeQueueEntry`; derive `queued` here, at the
  // point the item enters renderer state, using the one shared derivation.
  return item
    ? (withDerivedPullRequestQueueState({ ...item, repoId: args.repoId }) as GitHubWorkItem)
    : null
}

export async function lookupGitHubWorkItemByOwnerRepoForSource(
  args: GitHubWorkItemByOwnerRepoLookupArgs
): Promise<GitHubWorkItem | null> {
  const target = getGitHubSourceRuntimeTarget(args.sourceContext)
  const item =
    target.kind === 'environment'
      ? await callRuntimeRpc<Omit<GitHubWorkItem, 'repoId'> | null>(
          target,
          'github.workItemByOwnerRepo',
          {
            repo: runtimeRepoId(args),
            owner: args.owner,
            ownerRepo: args.repo,
            ...(args.host ? { host: args.host } : {}),
            number: args.number,
            type: args.type
          },
          { timeoutMs: 30_000 }
        )
      : await window.api.gh.workItemByOwnerRepo({
          repoPath: args.repoPath,
          repoId: args.repoId,
          owner: args.owner,
          repo: args.repo,
          ...(args.host ? { host: args.host } : {}),
          number: args.number,
          type: args.type
        })
  return item
    ? (withDerivedPullRequestQueueState({ ...item, repoId: args.repoId }) as GitHubWorkItem)
    : null
}

// Why: details are spread over the list-provided item on the PR page, so they must
// carry the derived state too — otherwise a queued PR flips back to Open on load.
function withDerivedDetailsQueueState(
  details: GitHubWorkItemDetails | null
): GitHubWorkItemDetails | null {
  if (!details) {
    return null
  }
  const item = withDerivedPullRequestQueueState(details.item)
  return item === details.item ? details : { ...details, item }
}

export function lookupGitHubWorkItemDetailsForSource(
  args: GitHubWorkItemDetailsLookupArgs
): Promise<GitHubWorkItemDetails | null> {
  const sourceContext = args.sourceContext
  const runtimeHost = getGitHubSourceRuntimeHost(sourceContext)
  if (runtimeHost) {
    return callRuntimeRpc<GitHubWorkItemDetails | null>(
      { kind: 'environment', environmentId: runtimeHost.environmentId },
      'github.workItemDetails',
      {
        repo: getGitHubRuntimeRepoId(sourceContext, args.repoId),
        number: args.number,
        type: args.type
      },
      { timeoutMs: 30_000 }
    ).then(withDerivedDetailsQueueState)
  }
  return window.api.gh
    .workItemDetails({
      repoPath: args.repoPath,
      repoId: args.repoId,
      sourceContext,
      number: args.number,
      type: args.type
    })
    .then(withDerivedDetailsQueueState)
}
