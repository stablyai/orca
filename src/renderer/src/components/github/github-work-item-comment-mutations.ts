import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { GhAccountBinding } from '../../../../shared/github/account-binding'
import { GITHUB_ACCOUNT_EXPECTATION_RUNTIME_CAPABILITY } from '../../../../shared/task-source-runtime-capabilities'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status-connection-generation'
import { RUNTIME_CONNECTION_CHANGED_MESSAGE } from '@/web/web-runtime-request-registry'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { emitGitHubWorkItemDetailsCacheMutation } from '@/lib/work-items/github/github-work-item-details-cache-events'
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
        ...(args.type ? { type: args.type } : {}),
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
  expectedGhAccount?: GhAccountBinding | null
  target?: RuntimeClientTarget
}): Promise<boolean> {
  const runtimeHost = getGitHubSourceRuntimeHost(args.sourceContext)
  const target = runtimeHost
    ? { kind: 'environment' as const, environmentId: runtimeHost.environmentId }
    : (args.target ?? { kind: 'local' as const })
  if (target.kind === 'environment') {
    const generation = getRuntimeEnvironmentConnectionGeneration(target.environmentId)
    const expectedGhAccount = args.expectedGhAccount
    const params = {
      repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId),
      prRepo: args.prRepo ?? null,
      pullRequestId: args.pullRequestId,
      path: args.path,
      viewed: args.viewed
    }
    return callRuntimeRpc<boolean>(target, 'github.setPRFileViewed', params, {
      timeoutMs: 30_000,
      ...(expectedGhAccount !== undefined
        ? {
            paramsForStatus: (status: RuntimeStatus | null) => ({
              ...params,
              ...(status?.capabilities?.includes(GITHUB_ACCOUNT_EXPECTATION_RUNTIME_CAPABILITY)
                ? { expectedGhAccount }
                : {})
            }),
            beforeSend: () => {
              if (getRuntimeEnvironmentConnectionGeneration(target.environmentId) !== generation) {
                throw new Error(RUNTIME_CONNECTION_CHANGED_MESSAGE)
              }
            }
          }
        : {})
    }).then((ok) => {
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
    viewed: args.viewed,
    ...(args.expectedGhAccount !== undefined ? { expectedGhAccount: args.expectedGhAccount } : {})
  })
}
