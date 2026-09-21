import type { LinearIssueUpdate } from '../../../shared/issue-mutation-types'
import type { LinearComment, LinearIssue } from '../../../shared/linear/issue-types'
import { callRuntimeRpc } from './runtime-rpc-client'
import {
  getLinearRuntimeTarget,
  type LinearCommentResult,
  type LinearCreateIssueResult,
  type LinearMutationResult,
  type RuntimeLinearSettings
} from './runtime-linear-client'

export async function linearCreateIssue(
  settings: RuntimeLinearSettings,
  args: {
    teamId: string
    title: string
    description?: string
    workspaceId?: string
    parentIssueId?: string
    projectId?: string | null
    stateId?: string
    priority?: number
    assigneeId?: string | null
    labelIds?: string[]
  }
): Promise<LinearCreateIssueResult> {
  const target = getLinearRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearCreateIssueResult>(target, 'linear.createIssue', args, {
        timeoutMs: 30_000
      })
    : window.api.linear.createIssue(args)
}

export async function linearCreateSubIssue(
  settings: RuntimeLinearSettings,
  args: {
    parentIssueId: string
    teamId: string
    title: string
    description?: string
    workspaceId?: string
    projectId?: string | null
  }
): Promise<LinearCreateIssueResult> {
  return linearCreateIssue(settings, args)
}

export async function linearGetIssue(
  settings: RuntimeLinearSettings,
  id: string,
  workspaceId?: string | null
): Promise<LinearIssue | null> {
  const target = getLinearRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearIssue | null>(
        target,
        'linear.getIssue',
        { id, workspaceId: workspaceId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.getIssue({ id, workspaceId: workspaceId ?? undefined })
}

export async function linearUpdateIssue(
  settings: RuntimeLinearSettings,
  id: string,
  updates: LinearIssueUpdate,
  workspaceId?: string | null
): Promise<LinearMutationResult> {
  const target = getLinearRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearMutationResult>(
        target,
        'linear.updateIssue',
        { id, updates, workspaceId: workspaceId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.updateIssue({ id, updates, workspaceId: workspaceId ?? undefined })
}

export async function linearAddIssueComment(
  settings: RuntimeLinearSettings,
  issueId: string,
  body: string,
  workspaceId?: string | null
): Promise<LinearCommentResult> {
  const target = getLinearRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearCommentResult>(
        target,
        'linear.addIssueComment',
        { issueId, body, workspaceId: workspaceId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.addIssueComment({ issueId, body, workspaceId: workspaceId ?? undefined })
}

export async function linearIssueComments(
  settings: RuntimeLinearSettings,
  issueId: string,
  workspaceId?: string | null
): Promise<LinearComment[]> {
  const target = getLinearRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearComment[]>(
        target,
        'linear.issueComments',
        { issueId, workspaceId: workspaceId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.issueComments({ issueId, workspaceId: workspaceId ?? undefined })
}
