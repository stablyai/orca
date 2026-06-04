/* eslint-disable max-lines -- Why: the renderer Linear client mirrors the
   preload/RPC Linear namespace so local and remote runtime routing stays in
   one auditable boundary. */
import type {
  GlobalSettings,
  LinearComment,
  LinearCollectionResult,
  LinearConnectionStatus,
  LinearCustomViewModel,
  LinearCustomViewSummary,
  LinearIssue,
  LinearIssueUpdate,
  LinearLabel,
  LinearMember,
  LinearProjectDetail,
  LinearProjectSummary,
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
  | { ok: true; id: string; identifier: string; title: string; url: string }
  | { ok: false; error: string }
export type LinearMutationResult = { ok: true } | { ok: false; error: string }
export type LinearCommentResult = { ok: true; id: string } | { ok: false; error: string }
export type LinearReadOptions = { force?: boolean }

function linearReadForce(options?: LinearReadOptions): { force: true } | {} {
  return options?.force ? { force: true } : {}
}

function normalizeLinearIssueCollectionResult(
  result: unknown
): LinearCollectionResult<LinearIssue> {
  if (Array.isArray(result)) {
    return { items: result as LinearIssue[] }
  }
  if (!result || typeof result !== 'object') {
    return { items: [] }
  }
  const collection = result as Partial<LinearCollectionResult<LinearIssue>>
  if (!Array.isArray(collection.items)) {
    return { items: [] }
  }
  return {
    items: collection.items,
    ...(Array.isArray(collection.errors) ? { errors: collection.errors } : {}),
    ...(typeof collection.hasMore === 'boolean' ? { hasMore: collection.hasMore } : {})
  }
}

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
): Promise<LinearCollectionResult<LinearIssue>> {
  const target = getActiveRuntimeTarget(settings)
  const result =
    target.kind === 'environment'
      ? await callRuntimeRpc<unknown>(
          target,
          'linear.listIssues',
          { filter, limit, workspaceId: workspaceId ?? undefined },
          { timeoutMs: 30_000 }
        )
      : await window.api.linear.listIssues({
          filter,
          limit,
          workspaceId: workspaceId ?? undefined
        })
  return normalizeLinearIssueCollectionResult(result)
}

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
  const target = getActiveRuntimeTarget(settings)
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

export async function linearListProjects(
  settings: RuntimeLinearSettings,
  query?: string,
  limit?: number,
  workspaceId?: LinearWorkspaceSelection | null,
  options?: LinearReadOptions
): Promise<LinearCollectionResult<LinearProjectSummary>> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearCollectionResult<LinearProjectSummary>>(
        target,
        'linear.listProjects',
        { query, limit, workspaceId: workspaceId ?? undefined, ...linearReadForce(options) },
        { timeoutMs: 30_000 }
      )
    : typeof window.api.linear.listProjects === 'function'
      ? window.api.linear.listProjects({
          query,
          limit,
          workspaceId: workspaceId ?? undefined,
          ...linearReadForce(options)
        })
      : { items: [] }
}

export async function linearGetProject(
  settings: RuntimeLinearSettings,
  id: string,
  workspaceId: string,
  options?: LinearReadOptions
): Promise<LinearProjectDetail | null> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearProjectDetail | null>(
        target,
        'linear.getProject',
        { id, workspaceId, ...linearReadForce(options) },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.getProject({ id, workspaceId, ...linearReadForce(options) })
}

export async function linearListProjectIssues(
  settings: RuntimeLinearSettings,
  projectId: string,
  limit: number | undefined,
  workspaceId: string,
  options?: LinearReadOptions
): Promise<LinearCollectionResult<LinearIssue>> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearCollectionResult<LinearIssue>>(
        target,
        'linear.listProjectIssues',
        { projectId, limit, workspaceId, ...linearReadForce(options) },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.listProjectIssues({
        projectId,
        limit,
        workspaceId,
        ...linearReadForce(options)
      })
}

export async function linearListCustomViews(
  settings: RuntimeLinearSettings,
  model: LinearCustomViewModel,
  limit?: number,
  workspaceId?: LinearWorkspaceSelection | null,
  options?: LinearReadOptions
): Promise<LinearCollectionResult<LinearCustomViewSummary>> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearCollectionResult<LinearCustomViewSummary>>(
        target,
        'linear.listCustomViews',
        { model, limit, workspaceId: workspaceId ?? undefined, ...linearReadForce(options) },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.listCustomViews({
        model,
        limit,
        workspaceId: workspaceId ?? undefined,
        ...linearReadForce(options)
      })
}

export async function linearGetCustomView(
  settings: RuntimeLinearSettings,
  viewId: string,
  model: LinearCustomViewModel,
  workspaceId: string,
  options?: LinearReadOptions
): Promise<LinearCustomViewSummary | null> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearCustomViewSummary | null>(
        target,
        'linear.getCustomView',
        { viewId, model, workspaceId, ...linearReadForce(options) },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.getCustomView({ viewId, model, workspaceId, ...linearReadForce(options) })
}

export async function linearListCustomViewIssues(
  settings: RuntimeLinearSettings,
  viewId: string,
  limit: number | undefined,
  workspaceId: string,
  options?: LinearReadOptions
): Promise<LinearCollectionResult<LinearIssue>> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearCollectionResult<LinearIssue>>(
        target,
        'linear.listCustomViewIssues',
        { viewId, limit, workspaceId, ...linearReadForce(options) },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.listCustomViewIssues({
        viewId,
        limit,
        workspaceId,
        ...linearReadForce(options)
      })
}

export async function linearListCustomViewProjects(
  settings: RuntimeLinearSettings,
  viewId: string,
  limit: number | undefined,
  workspaceId: string,
  options?: LinearReadOptions
): Promise<LinearCollectionResult<LinearProjectSummary>> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearCollectionResult<LinearProjectSummary>>(
        target,
        'linear.listCustomViewProjects',
        { viewId, limit, workspaceId, ...linearReadForce(options) },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.listCustomViewProjects({
        viewId,
        limit,
        workspaceId,
        ...linearReadForce(options)
      })
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
