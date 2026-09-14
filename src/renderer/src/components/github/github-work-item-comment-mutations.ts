import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { emitGitHubWorkItemDetailsCacheMutation } from '@/lib/github-work-item-details-cache-events'
import {
  getGitHubRuntimeRepoId,
  getGitHubSourceRuntimeHost
} from '@/lib/github-source-runtime-context'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'

export function addIssueCommentForRepo(args: {
  repoId?: string
  repoPath: string
  sourceContext?: TaskSourceContext | null
  number: number
  body: string
  type?: 'issue' | 'pr'
  prRepo?: GitHubOwnerRepo | null
}): Promise<Awaited<ReturnType<typeof window.api.gh.addIssueComment>>> {
  const runtimeHost = getGitHubSourceRuntimeHost(args.sourceContext)
  if (runtimeHost) {
    return callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.addIssueComment>>>(
      { kind: 'environment', environmentId: runtimeHost.environmentId },
      'github.addIssueComment',
      {
        repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId),
        number: args.number,
        body: args.body,
        prRepo: args.prRepo ?? null
      },
      { timeoutMs: 30_000 }
    ).then((result) => {
      if (result.ok) {
        notifyWorkItemDetailsMutation(
          {
            repoPath: args.repoPath,
            repoId: args.repoId,
            sourceContext: args.sourceContext,
            type: args.type ?? 'issue',
            number: args.number
          },
          { local: false }
        )
      }
      return result
    })
  }
  return window.api.gh.addIssueComment({
    repoPath: args.repoPath,
    repoId: args.repoId,
    sourceContext: args.sourceContext,
    number: args.number,
    body: args.body,
    type: args.type,
    prRepo: args.prRepo ?? null
  })
}

export function addPRReviewCommentForRepo(args: {
  repoId?: string
  repoPath: string
  sourceContext?: TaskSourceContext | null
  prNumber: number
  prRepo?: GitHubOwnerRepo | null
  commitId: string
  path: string
  line: number
  startLine?: number
  body: string
}): Promise<Awaited<ReturnType<typeof window.api.gh.addPRReviewComment>>> {
  const runtimeHost = getGitHubSourceRuntimeHost(args.sourceContext)
  if (runtimeHost) {
    return callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.addPRReviewComment>>>(
      { kind: 'environment', environmentId: runtimeHost.environmentId },
      'github.addPRReviewComment',
      {
        repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId),
        prNumber: args.prNumber,
        prRepo: args.prRepo ?? null,
        commitId: args.commitId,
        path: args.path,
        line: args.line,
        startLine: args.startLine,
        body: args.body
      },
      { timeoutMs: 30_000 }
    ).then((result) => {
      if (result.ok) {
        notifyWorkItemDetailsMutation(
          {
            repoPath: args.repoPath,
            repoId: args.repoId,
            sourceContext: args.sourceContext,
            type: 'pr',
            number: args.prNumber
          },
          { local: false }
        )
      }
      return result
    })
  }
  return window.api.gh.addPRReviewComment({
    repoPath: args.repoPath,
    repoId: args.repoId,
    sourceContext: args.sourceContext,
    prNumber: args.prNumber,
    prRepo: args.prRepo ?? null,
    commitId: args.commitId,
    path: args.path,
    line: args.line,
    startLine: args.startLine,
    body: args.body
  })
}

export function addPRReviewCommentReplyForRepo(args: {
  repoId?: string
  repoPath: string
  sourceContext?: TaskSourceContext | null
  prNumber: number
  prRepo?: GitHubOwnerRepo | null
  commentId: number
  body: string
  threadId?: string
  path?: string
  line?: number
}): Promise<Awaited<ReturnType<typeof window.api.gh.addPRReviewCommentReply>>> {
  const runtimeHost = getGitHubSourceRuntimeHost(args.sourceContext)
  if (runtimeHost) {
    return callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.addPRReviewCommentReply>>>(
      { kind: 'environment', environmentId: runtimeHost.environmentId },
      'github.addPRReviewCommentReply',
      {
        repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId),
        prNumber: args.prNumber,
        prRepo: args.prRepo ?? null,
        commentId: args.commentId,
        body: args.body,
        threadId: args.threadId,
        path: args.path,
        line: args.line
      },
      { timeoutMs: 30_000 }
    ).then((result) => {
      if (result.ok) {
        notifyWorkItemDetailsMutation(
          {
            repoPath: args.repoPath,
            repoId: args.repoId,
            sourceContext: args.sourceContext,
            type: 'pr',
            number: args.prNumber
          },
          { local: false }
        )
      }
      return result
    })
  }
  return window.api.gh.addPRReviewCommentReply({
    repoPath: args.repoPath,
    repoId: args.repoId,
    sourceContext: args.sourceContext,
    prNumber: args.prNumber,
    prRepo: args.prRepo ?? null,
    commentId: args.commentId,
    body: args.body,
    threadId: args.threadId,
    path: args.path,
    line: args.line
  })
}

export function notifyWorkItemDetailsMutation(
  args: {
    repoPath: string
    repoId?: string
    sourceContext?: TaskSourceContext | null
    type: 'issue' | 'pr'
    number: number
  },
  options: { local?: boolean } = {}
): void {
  if (options.local !== false) {
    emitGitHubWorkItemDetailsCacheMutation(args)
  }
  void window.api.gh
    .notifyWorkItemMutated({
      repoPath: args.repoPath,
      repoId: args.repoId,
      type: args.type,
      number: args.number
    })
    .catch(() => undefined)
}

export function setPRFileViewedForRepo(args: {
  repoId: string
  repoPath: string
  sourceContext?: TaskSourceContext | null
  prNumber: number
  prRepo?: GitHubOwnerRepo | null
  pullRequestId: string
  path: string
  viewed: boolean
}): Promise<boolean> {
  const runtimeHost = getGitHubSourceRuntimeHost(args.sourceContext)
  if (runtimeHost) {
    return callRuntimeRpc<boolean>(
      { kind: 'environment', environmentId: runtimeHost.environmentId },
      'github.setPRFileViewed',
      {
        repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId),
        prRepo: args.prRepo ?? null,
        pullRequestId: args.pullRequestId,
        path: args.path,
        viewed: args.viewed
      },
      { timeoutMs: 30_000 }
    ).then((ok) => {
      if (ok) {
        notifyWorkItemDetailsMutation(
          {
            repoPath: args.repoPath,
            repoId: args.repoId,
            sourceContext: args.sourceContext,
            type: 'pr',
            number: args.prNumber
          },
          { local: false }
        )
      }
      return ok
    })
  }
  return window.api.gh.setPRFileViewed({
    repoPath: args.repoPath,
    repoId: args.repoId,
    sourceContext: args.sourceContext,
    prNumber: args.prNumber,
    prRepo: args.prRepo ?? null,
    pullRequestId: args.pullRequestId,
    path: args.path,
    viewed: args.viewed
  })
}
