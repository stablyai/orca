import type { LinearIssue } from '../../../shared/linear/issue-types'
import type {
  LinearCustomViewModel,
  LinearCustomViewSummary,
  LinearProjectDetail,
  LinearProjectSummary
} from '../../../shared/linear/project-types'
import type {
  LinearCollectionResult,
  LinearLabel,
  LinearMember,
  LinearTeam,
  LinearWorkflowState,
  LinearWorkspaceSelection
} from '../../../shared/linear/workspace-types'
import { isRuntimeProviderSearchQueryWithinLimit } from './runtime-provider-search-bounds'
import { callRuntimeRpc } from './runtime-rpc-client'
import {
  getLinearRuntimeTarget,
  linearReadForce,
  type LinearCreateProjectResult,
  type LinearReadOptions,
  type RuntimeLinearSettings
} from './runtime-linear-client'

export async function linearListTeams(
  settings: RuntimeLinearSettings,
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearTeam[]> {
  const target = getLinearRuntimeTarget(settings)
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
  if (!isRuntimeProviderSearchQueryWithinLimit(query)) {
    return { items: [] }
  }
  const target = getLinearRuntimeTarget(settings)
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

export async function linearCreateProject(
  settings: RuntimeLinearSettings,
  args: {
    name: string
    description?: string
    content?: string
    teamIds: string[]
    workspaceId?: string
    leadId?: string | null
    memberIds?: string[]
    labelIds?: string[]
    priority?: number
    startDate?: string
    targetDate?: string
  }
): Promise<LinearCreateProjectResult> {
  const target = getLinearRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearCreateProjectResult>(target, 'linear.createProject', args, {
        timeoutMs: 30_000
      })
    : window.api.linear.createProject(args)
}

export async function linearGetProject(
  settings: RuntimeLinearSettings,
  id: string,
  workspaceId: string,
  options?: LinearReadOptions
): Promise<LinearProjectDetail | null> {
  const target = getLinearRuntimeTarget(settings)
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
  const target = getLinearRuntimeTarget(settings)
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
  const target = getLinearRuntimeTarget(settings)
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
  const target = getLinearRuntimeTarget(settings)
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
  const target = getLinearRuntimeTarget(settings)
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
  const target = getLinearRuntimeTarget(settings)
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
  const target = getLinearRuntimeTarget(settings)
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
  const target = getLinearRuntimeTarget(settings)
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
  const target = getLinearRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearMember[]>(
        target,
        'linear.teamMembers',
        { teamId, workspaceId: workspaceId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.teamMembers({ teamId, workspaceId: workspaceId ?? undefined })
}
