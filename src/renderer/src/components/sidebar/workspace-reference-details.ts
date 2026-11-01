import type { WorkspaceAttachment, Worktree } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import {
  type TaskSourceContext,
  getTaskSourceCacheScope,
  buildTaskSourceContextFromRepo
} from '../../../../shared/task-source-context'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import {
  getWorkspaceAttachmentKey,
  getWorkspaceAttachmentUrlScope
} from '../../../../shared/workspace-attachment-normalization'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments'
import { getWorkspaceAttachmentSourceContext } from './workspace-attachment-source-result'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import type { HostedReviewProvider } from '../../../../shared/hosted-review'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'

export type WorkspaceReferenceDetails = {
  stale?: boolean
  title: string
  url: string
  review?: WorktreeCardPrDisplay
  stateName?: string
  stateType?: string
  issueState?: 'open' | 'closed'
}
export type WorkspaceReferenceDetailsMap = Readonly<
  Record<string, WorkspaceReferenceDetails | undefined>
>
export type WorkspaceReferenceRequest = {
  admissionTier?: 'interactive' | 'status' | 'background'
  knownProvider?: HostedReviewProvider
  key: string
  item: WorkspaceAttachment
  workspace: Worktree
  repo?: Repo
  sourceContext: TaskSourceContext | null
}

export function getWorkspaceReferenceLinearWorkspaceId(
  workspaceId?: string | null,
  source?: TaskSourceContext | null
): string {
  const identity = source?.providerIdentity
  return workspaceId ?? (identity?.provider === 'linear' ? identity.workspaceId : null) ?? 'all'
}

export function getWorkspaceReferenceRequest(
  item: WorkspaceAttachment,
  workspace: Worktree,
  repo?: Repo,
  runtimeVersion = getWorkspaceReferenceRuntimeVersion(workspace, repo)
): WorkspaceReferenceRequest {
  const sourceContext =
    item.taskSourceContext ??
    (item.type !== 'issue' && repo && (item.provider === 'github' || item.provider === 'gitlab')
      ? buildTaskSourceContextFromRepo({
          provider: item.provider,
          projectId: workspace.projectId ?? repo.id,
          repo
        })
      : item.provider === 'github' ||
          item.provider === 'gitlab' ||
          item.provider === 'linear' ||
          item.provider === 'jira'
        ? getWorkspaceAttachmentSourceContext(item.provider, repo, workspace)
        : null)
  return {
    item,
    workspace,
    repo,
    sourceContext,
    key: JSON.stringify([
      getWorkspaceAttachmentKey(item),
      repo
        ? [repo.id, repo.path, getRepoExecutionHostId(repo), repo.gitRemoteIdentity?.canonicalKey]
        : [workspace.hostId, workspace.projectId],
      sourceContext ? getTaskSourceCacheScope(sourceContext) : null,
      sourceContext?.accountLabel ?? null,
      repo?.ghAccount ?? null,
      runtimeVersion
    ])
  }
}

export function getWorkspaceReferenceRuntimeVersion(workspace: Worktree, repo?: Repo): string {
  const contexts = getWorkspaceAttachments(workspace).map((item) => item.taskSourceContext?.hostId)
  const hosts = [
    repo ? getRepoExecutionHostId(repo) : workspace.hostId,
    workspace.linkedTaskSourceContext?.hostId,
    ...contexts
  ]
  const environments = hosts
    .map((hostId) => parseExecutionHostId(hostId))
    .flatMap((host) => (host?.kind === 'runtime' ? [host.environmentId] : []))
  return JSON.stringify([
    getProviderRuntimeContextKey(null),
    ...[...new Set(environments)].sort().map((id) => [id, getRuntimeEnvironmentRevision(id)])
  ])
}

export function matchesWorkspaceReferenceUrl(item: WorkspaceAttachment, url: string): boolean {
  return (
    !item.url ||
    getWorkspaceAttachmentUrlScope(item) === getWorkspaceAttachmentUrlScope({ ...item, url })
  )
}

export function matchWorkspaceReferenceReview(
  item: WorkspaceAttachment,
  review: WorktreeCardPrDisplay | null | undefined
): boolean {
  return Boolean(
    item.type !== 'issue' &&
    review?.url &&
    item.provider === review.provider &&
    item.number === review.number &&
    matchesWorkspaceReferenceUrl(item, review.url)
  )
}

export function workspaceReferenceReview(
  item: WorkspaceAttachment,
  details: WorkspaceReferenceDetails | undefined
): WorktreeCardPrDisplay | null {
  if (item.provider === 'linear' || item.provider === 'jira' || item.type === 'issue') {
    return null
  }
  return (
    details?.review ?? {
      provider: item.provider,
      number: item.number,
      title: item.title ?? '',
      url: item.url
    }
  )
}
