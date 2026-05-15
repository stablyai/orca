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
  LinearWorkspaceSelection,
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
  settings: RuntimeLinearSettings,
  workspaceId?: string | null
): Promise<LinearConnectResult> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearConnectResult>(
        target,
        'linear.testConnection',
        workspaceId ? { workspaceId } : undefined,
        {
          timeoutMs: 30_000
        }
      )
    : window.api.linear.testConnection(workspaceId ? { workspaceId } : undefined)
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
  return linearDisconnectWorkspace(settings)
}

export async function linearDisconnectWorkspace(
  settings: RuntimeLinearSettings,
  workspaceId?: string | null
): Promise<void> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await callRuntimeRpc<{ ok: true }>(
      target,
      'linear.disconnect',
      workspaceId ? { workspaceId } : undefined,
      {
        timeoutMs: 15_000
      }
    )
    return
  }
  await window.api.linear.disconnect(workspaceId ? { workspaceId } : undefined)
}

export async function linearSelectWorkspace(
  settings: RuntimeLinearSettings,
  workspaceId: LinearWorkspaceSelection
): Promise<LinearConnectionStatus> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearConnectionStatus>(
        target,
        'linear.selectWorkspace',
        { workspaceId },
        { timeoutMs: 15_000 }
      )
    : window.api.linear.selectWorkspace({ workspaceId })
}

export async function linearSearchIssues(
  settings: RuntimeLinearSettings,
  query: string,
  limit?: number,
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearIssue[]> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearIssue[]>(
        target,
        'linear.searchIssues',
        { query, limit, workspaceId: workspaceId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.searchIssues({ query, limit, workspaceId: workspaceId ?? undefined })
}

export async function linearListIssues(
  settings: RuntimeLinearSettings,
  filter?: LinearIssueFilter,
  limit?: number,
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearIssue[]> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearIssue[]>(
        target,
        'linear.listIssues',
        { filter, limit, workspaceId: workspaceId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.listIssues({ filter, limit, workspaceId: workspaceId ?? undefined })
}

export async function linearCreateIssue(
  settings: RuntimeLinearSettings,
  args: { teamId: string; title: string; description?: string; workspaceId?: string }
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
  id: string,
  workspaceId?: string | null
): Promise<LinearIssue | null> {
  const target = getActiveRuntimeTarget(settings)
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
  const target = getActiveRuntimeTarget(settings)
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
  const target = getActiveRuntimeTarget(settings)
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
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearComment[]>(
        target,
        'linear.issueComments',
        { issueId, workspaceId: workspaceId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.issueComments({ issueId, workspaceId: workspaceId ?? undefined })
}

export async function linearListTeams(
  settings: RuntimeLinearSettings,
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearTeam[]> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearTeam[]>(
        target,
        'linear.listTeams',
        workspaceId ? { workspaceId } : undefined,
        { timeoutMs: 30_000 }
      )
    : window.api.linear.listTeams(workspaceId ? { workspaceId } : undefined)
}

export async function linearTeamStates(
  settings: RuntimeLinearSettings,
  teamId: string,
  workspaceId?: string | null
): Promise<LinearWorkflowState[]> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearWorkflowState[]>(
        target,
        'linear.teamStates',
        { teamId, workspaceId: workspaceId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.teamStates({ teamId, workspaceId: workspaceId ?? undefined })
}

export async function linearTeamLabels(
  settings: RuntimeLinearSettings,
  teamId: string,
  workspaceId?: string | null
): Promise<LinearLabel[]> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearLabel[]>(
        target,
        'linear.teamLabels',
        { teamId, workspaceId: workspaceId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.teamLabels({ teamId, workspaceId: workspaceId ?? undefined })
}

export async function linearTeamMembers(
  settings: RuntimeLinearSettings,
  teamId: string,
  workspaceId?: string | null
): Promise<LinearMember[]> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearMember[]>(
        target,
        'linear.teamMembers',
        { teamId, workspaceId: workspaceId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.teamMembers({ teamId, workspaceId: workspaceId ?? undefined })
}
