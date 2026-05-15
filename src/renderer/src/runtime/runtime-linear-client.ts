import type {
  GlobalSettings,
  LinearComment,
  LinearConnectionStatus,
  LinearIssue,
  LinearIssueUpdate,
  LinearLabel,
  LinearMember,
  LinearTeam,
  LinearViewer,
  LinearWorkflowState
} from '../../../shared/types'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'

export type RuntimeLinearSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | null
  | undefined

export type LinearIssueFilter = 'assigned' | 'created' | 'all' | 'completed'
export type LinearConnectResult = { ok: true; viewer: LinearViewer } | { ok: false; error: string }
export type LinearCreateIssueResult =
  | { ok: true; id: string; identifier: string; url: string }
  | { ok: false; error: string }
export type LinearMutationResult = { ok: true } | { ok: false; error: string }
export type LinearCommentResult = { ok: true; id: string } | { ok: false; error: string }

export async function linearStatus(
  settings: RuntimeLinearSettings
): Promise<LinearConnectionStatus> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearConnectionStatus>(target, 'linear.status', undefined, {
        timeoutMs: 15_000
      })
    : window.api.linear.status()
}

export async function linearTestConnection(
  settings: RuntimeLinearSettings
): Promise<LinearConnectResult> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearConnectResult>(target, 'linear.testConnection', undefined, {
        timeoutMs: 30_000
      })
    : window.api.linear.testConnection()
}

export async function linearConnect(
  settings: RuntimeLinearSettings,
  apiKey: string
): Promise<LinearConnectResult> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearConnectResult>(
        target,
        'linear.connect',
        { apiKey },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.connect({ apiKey })
}

export async function linearDisconnect(settings: RuntimeLinearSettings): Promise<void> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await callRuntimeRpc<{ ok: true }>(target, 'linear.disconnect', undefined, {
      timeoutMs: 15_000
    })
    return
  }
  await window.api.linear.disconnect()
}

export async function linearSearchIssues(
  settings: RuntimeLinearSettings,
  query: string,
  limit?: number
): Promise<LinearIssue[]> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearIssue[]>(
        target,
        'linear.searchIssues',
        { query, limit },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.searchIssues({ query, limit })
}

export async function linearListIssues(
  settings: RuntimeLinearSettings,
  filter?: LinearIssueFilter,
  limit?: number
): Promise<LinearIssue[]> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearIssue[]>(
        target,
        'linear.listIssues',
        { filter, limit },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.listIssues({ filter, limit })
}

export async function linearCreateIssue(
  settings: RuntimeLinearSettings,
  args: { teamId: string; title: string; description?: string }
): Promise<LinearCreateIssueResult> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearCreateIssueResult>(target, 'linear.createIssue', args, {
        timeoutMs: 30_000
      })
    : window.api.linear.createIssue(args)
}

export async function linearGetIssue(
  settings: RuntimeLinearSettings,
  id: string
): Promise<LinearIssue | null> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearIssue | null>(target, 'linear.getIssue', { id }, { timeoutMs: 30_000 })
    : window.api.linear.getIssue({ id })
}

export async function linearUpdateIssue(
  settings: RuntimeLinearSettings,
  id: string,
  updates: LinearIssueUpdate
): Promise<LinearMutationResult> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearMutationResult>(
        target,
        'linear.updateIssue',
        { id, updates },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.updateIssue({ id, updates })
}

export async function linearAddIssueComment(
  settings: RuntimeLinearSettings,
  issueId: string,
  body: string
): Promise<LinearCommentResult> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearCommentResult>(
        target,
        'linear.addIssueComment',
        { issueId, body },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.addIssueComment({ issueId, body })
}

export async function linearIssueComments(
  settings: RuntimeLinearSettings,
  issueId: string
): Promise<LinearComment[]> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearComment[]>(
        target,
        'linear.issueComments',
        { issueId },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.issueComments({ issueId })
}

export async function linearListTeams(settings: RuntimeLinearSettings): Promise<LinearTeam[]> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearTeam[]>(target, 'linear.listTeams', undefined, { timeoutMs: 30_000 })
    : window.api.linear.listTeams()
}

export async function linearTeamStates(
  settings: RuntimeLinearSettings,
  teamId: string
): Promise<LinearWorkflowState[]> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearWorkflowState[]>(
        target,
        'linear.teamStates',
        { teamId },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.teamStates({ teamId })
}

export async function linearTeamLabels(
  settings: RuntimeLinearSettings,
  teamId: string
): Promise<LinearLabel[]> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearLabel[]>(target, 'linear.teamLabels', { teamId }, { timeoutMs: 30_000 })
    : window.api.linear.teamLabels({ teamId })
}

export async function linearTeamMembers(
  settings: RuntimeLinearSettings,
  teamId: string
): Promise<LinearMember[]> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearMember[]>(
        target,
        'linear.teamMembers',
        { teamId },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.teamMembers({ teamId })
}
