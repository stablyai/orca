import type { PreloadApi } from '../../../../preload/api-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { GITHUB_WEB_RPC_METHODS } from '@/web/preload-api/web-github-routes'
import { callRuntimeRpc } from '../rpc/calls/runtime-rpc-call'
import {
  forgeCredentialTarget,
  forgeOwnerHostIdForWorkspace
} from '../source-control/forge/forge-credential-target'

type GitHubApi = PreloadApi['gh']

export type GitHubSlugApi = Pick<
  GitHubApi,
  | 'projectWorkItemDetailsBySlug'
  | 'updateIssueBySlug'
  | 'updatePullRequestBySlug'
  | 'addIssueCommentBySlug'
  | 'updateIssueCommentBySlug'
  | 'deleteIssueCommentBySlug'
  | 'listLabelsBySlug'
  | 'listAssignableUsersBySlug'
  | 'listIssueTypesBySlug'
  | 'updateIssueTypeBySlug'
>

type GitHubSlugMethod = keyof GitHubSlugApi
type SlugArgs<K extends GitHubSlugMethod> = Parameters<GitHubSlugApi[K]>[0]
type SlugResult<K extends GitHubSlugMethod> = Awaited<ReturnType<GitHubSlugApi[K]>>

const GITHUB_SLUG_RPC_TIMEOUT_MS = 30_000

// Why: the owning host gates its own WSL wakes; the hint is for local IPC only.
function withoutWslWake<T extends object>(args: T): Omit<T, 'wakeWslDistro'> {
  if (!('wakeWslDistro' in args)) {
    return args
  }
  const { wakeWslDistro: _wake, ...params } = args
  return params
}

function runtimeGitHubSlugApi(environmentId: string): GitHubSlugApi {
  const target = { kind: 'environment', environmentId } as const
  const call =
    <K extends GitHubSlugMethod>(method: K) =>
    (args: SlugArgs<K>): Promise<SlugResult<K>> =>
      callRuntimeRpc<SlugResult<K>>(target, GITHUB_WEB_RPC_METHODS[method], withoutWslWake(args), {
        timeoutMs: GITHUB_SLUG_RPC_TIMEOUT_MS
      })
  return {
    projectWorkItemDetailsBySlug: call('projectWorkItemDetailsBySlug'),
    updateIssueBySlug: call('updateIssueBySlug'),
    updatePullRequestBySlug: call('updatePullRequestBySlug'),
    addIssueCommentBySlug: call('addIssueCommentBySlug'),
    updateIssueCommentBySlug: call('updateIssueCommentBySlug'),
    deleteIssueCommentBySlug: call('deleteIssueCommentBySlug'),
    listLabelsBySlug: call('listLabelsBySlug'),
    listAssignableUsersBySlug: call('listAssignableUsersBySlug'),
    listIssueTypesBySlug: call('listIssueTypesBySlug'),
    updateIssueTypeBySlug: call('updateIssueTypeBySlug')
  }
}

function rejectingGitHubSlugApi(error: unknown): GitHubSlugApi {
  const reject = () => Promise.reject(error)
  return {
    projectWorkItemDetailsBySlug: reject,
    updateIssueBySlug: reject,
    updatePullRequestBySlug: reject,
    addIssueCommentBySlug: reject,
    updateIssueCommentBySlug: reject,
    deleteIssueCommentBySlug: reject,
    listLabelsBySlug: reject,
    listAssignableUsersBySlug: reject,
    listIssueTypesBySlug: reject,
    updateIssueTypeBySlug: reject
  }
}

/** The slug-addressed `gh` API on an already-resolved credential target. */
export function gitHubSlugApiForTarget(target: RuntimeClientTarget): GitHubSlugApi {
  return target.kind === 'environment' ? runtimeGitHubSlugApi(target.environmentId) : window.api.gh
}

/** The slug-addressed `gh` API on the machine that owns this workspace's GitHub credentials. */
export function gitHubSlugApiForWorkspace(
  ...workspace: Parameters<typeof forgeOwnerHostIdForWorkspace>
): GitHubSlugApi {
  return gitHubSlugApiResolving(() =>
    forgeCredentialTarget({ repoOwnerExecutionHostId: forgeOwnerHostIdForWorkspace(...workspace) })
  )
}

function gitHubSlugApiResolving(resolveTarget: () => RuntimeClientTarget): GitHubSlugApi {
  let target: RuntimeClientTarget
  try {
    target = resolveTarget()
  } catch (error) {
    // Why: callers await the call; an unknown owner must reject, never fall back to this computer.
    return rejectingGitHubSlugApi(error)
  }
  return gitHubSlugApiForTarget(target)
}
