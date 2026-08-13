/* eslint-disable max-lines -- Why: the renderer Huly client mirrors the
   preload/RPC Huly namespace so local and remote runtime routing stays in
   one auditable boundary. */
import type {
  GlobalSettings,
  HulyComment,
  HulyConnectionStatus,
  HulyIssue,
  HulyIssueState,
  HulyIssueUpdate,
  HulyLabel,
  HulyProjectDetail,
  HulyProjectSummary,
  HulyTeamMember,
  HulyTeamSummary,
  HulyViewer
} from '../../../shared/types'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../shared/task-source-context'

export type RuntimeHulySettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | TaskSourceContext
  | null
  | undefined

export type HulyListFilter = 'assigned' | 'created' | 'all'

export type HulyConnectResult = { ok: true; viewer: HulyViewer } | { ok: false; error: string }

export type HulyMutationResult = { ok: true } | { ok: false; error: string }
export type HulyCommentResult = { ok: true; comment: HulyComment } | { ok: false; error: string }
export type HulyCreateIssueResult = { ok: true; issue: HulyIssue } | { ok: false; error: string }
export type HulyCreateProjectResult =
  | { ok: true; project: HulyProjectSummary }
  | { ok: false; error: string }

function isTaskSourceRuntimeSettings(settings: RuntimeHulySettings): settings is TaskSourceContext {
  return settings !== null && settings !== undefined && 'kind' in settings
}

function getHulyRuntimeTarget(settings: RuntimeHulySettings) {
  return getActiveRuntimeTarget(
    isTaskSourceRuntimeSettings(settings) ? getTaskSourceRuntimeSettings(settings) : settings
  )
}

export async function hulyStatus(settings: RuntimeHulySettings): Promise<HulyConnectionStatus> {
  const target = getHulyRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<HulyConnectionStatus>(target, 'huly.status', undefined, {
        timeoutMs: 15_000
      })
    : window.api.huly.status()
}

export async function hulyPreflight(
  settings: RuntimeHulySettings
): Promise<{ installed: boolean; authenticated: boolean; cliVersion?: string }> {
  const target = getHulyRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc(target, 'huly.preflight', undefined, { timeoutMs: 10_000 })
    : window.api.huly.preflight()
}

export async function hulyConnect(
  settings: RuntimeHulySettings,
  args: {
    name: string
    url: string
    workspace: string
    email: string | null
    secret: string
  }
): Promise<HulyConnectResult> {
  const target = getHulyRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<HulyConnectResult>(target, 'huly.connect', args, {
        timeoutMs: 30_000
      })
    : window.api.huly.connect(args)
}

export async function hulyDisconnect(
  settings: RuntimeHulySettings,
  connectionId?: string | null
): Promise<void> {
  const target = getHulyRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await callRuntimeRpc(target, 'huly.disconnect', connectionId ? { connectionId } : undefined, {
      timeoutMs: 15_000
    })
    return
  }
  await window.api.huly.disconnect(connectionId ? { connectionId } : undefined)
}

export async function hulySelectConnection(
  settings: RuntimeHulySettings,
  connectionId: string
): Promise<HulyConnectionStatus> {
  const target = getHulyRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<HulyConnectionStatus>(
        target,
        'huly.selectConnection',
        { connectionId },
        { timeoutMs: 15_000 }
      )
    : window.api.huly.selectConnection({ connectionId })
}

export async function hulySearchIssues(
  settings: RuntimeHulySettings,
  query: string,
  limit?: number,
  connectionId?: string | null
): Promise<HulyIssue[]> {
  const target = getHulyRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<HulyIssue[]>(
        target,
        'huly.searchIssues',
        { query, limit, connectionId: connectionId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.huly.searchIssues({ query, limit, connectionId: connectionId ?? undefined })
}

export async function hulyListIssues(
  settings: RuntimeHulySettings,
  filter?: HulyListFilter,
  limit?: number,
  connectionId?: string | null
): Promise<HulyIssue[]> {
  const target = getHulyRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<HulyIssue[]>(
        target,
        'huly.listIssues',
        { filter, limit, connectionId: connectionId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.huly.listIssues({
        filter,
        limit,
        connectionId: connectionId ?? undefined
      })
}

export async function hulyGetIssue(
  settings: RuntimeHulySettings,
  id: string,
  connectionId?: string | null
): Promise<HulyIssue | null> {
  const target = getHulyRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<HulyIssue | null>(
        target,
        'huly.getIssue',
        { id, connectionId: connectionId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.huly.getIssue({ id, connectionId: connectionId ?? undefined })
}

export async function hulyCreateIssue(
  settings: RuntimeHulySettings,
  args: Parameters<typeof window.api.huly.createIssue>[0]
): Promise<HulyCreateIssueResult> {
  const target = getHulyRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<HulyCreateIssueResult>(target, 'huly.createIssue', args, {
        timeoutMs: 30_000
      })
    : window.api.huly.createIssue(args)
}

export async function hulyUpdateIssue(
  settings: RuntimeHulySettings,
  id: string,
  updates: HulyIssueUpdate,
  connectionId?: string | null
): Promise<HulyMutationResult> {
  const target = getHulyRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<HulyMutationResult>(
        target,
        'huly.updateIssue',
        { id, updates, connectionId: connectionId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.huly.updateIssue({ id, updates, connectionId: connectionId ?? undefined })
}

export async function hulyAddComment(
  settings: RuntimeHulySettings,
  issueId: string,
  body: string,
  connectionId?: string | null
): Promise<HulyCommentResult> {
  const target = getHulyRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<HulyCommentResult>(
        target,
        'huly.addComment',
        { issueId, body, connectionId: connectionId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.huly.addComment({ issueId, body, connectionId: connectionId ?? undefined })
}

export async function hulyListComments(
  settings: RuntimeHulySettings,
  issueId: string,
  connectionId?: string | null
): Promise<HulyComment[]> {
  const target = getHulyRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<HulyComment[]>(
        target,
        'huly.listComments',
        { issueId, connectionId: connectionId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.huly.listComments({ issueId, connectionId: connectionId ?? undefined })
}

export async function hulyListTeams(
  settings: RuntimeHulySettings,
  connectionId?: string | null
): Promise<HulyTeamSummary[]> {
  const target = getHulyRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<HulyTeamSummary[]>(
        target,
        'huly.listTeams',
        { connectionId: connectionId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.huly.listTeams({ connectionId: connectionId ?? undefined })
}

export async function hulyTeamMembers(
  settings: RuntimeHulySettings,
  teamId: string,
  connectionId?: string | null
): Promise<HulyTeamMember[]> {
  const target = getHulyRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<HulyTeamMember[]>(
        target,
        'huly.teamMembers',
        { teamId, connectionId: connectionId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.huly.teamMembers({ teamId, connectionId: connectionId ?? undefined })
}

export async function hulyTeamStates(
  settings: RuntimeHulySettings,
  teamId: string,
  connectionId?: string | null
): Promise<HulyIssueState[]> {
  const target = getHulyRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<HulyIssueState[]>(
        target,
        'huly.teamStates',
        { teamId, connectionId: connectionId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.huly.teamStates({ teamId, connectionId: connectionId ?? undefined })
}

export async function hulyTeamLabels(
  settings: RuntimeHulySettings,
  teamId: string,
  connectionId?: string | null
): Promise<HulyLabel[]> {
  const target = getHulyRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<HulyLabel[]>(
        target,
        'huly.teamLabels',
        { teamId, connectionId: connectionId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.huly.teamLabels({ teamId, connectionId: connectionId ?? undefined })
}

export async function hulyListProjects(
  settings: RuntimeHulySettings,
  query?: string,
  limit?: number,
  connectionId?: string | null
): Promise<HulyProjectSummary[]> {
  const target = getHulyRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<HulyProjectSummary[]>(
        target,
        'huly.listProjects',
        { query, limit, connectionId: connectionId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.huly.listProjects({ query, limit, connectionId: connectionId ?? undefined })
}

export async function hulyGetProject(
  settings: RuntimeHulySettings,
  id: string,
  connectionId?: string | null
): Promise<HulyProjectDetail | null> {
  const target = getHulyRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<HulyProjectDetail | null>(
        target,
        'huly.getProject',
        { id, connectionId: connectionId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.huly.getProject({ id, connectionId: connectionId ?? undefined })
}

export async function hulyCreateProject(
  settings: RuntimeHulySettings,
  args: Parameters<typeof window.api.huly.createProject>[0]
): Promise<HulyCreateProjectResult> {
  const target = getHulyRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<HulyCreateProjectResult>(target, 'huly.createProject', args, {
        timeoutMs: 30_000
      })
    : window.api.huly.createProject(args)
}

export async function hulyListProjectIssues(
  settings: RuntimeHulySettings,
  projectId: string,
  limit?: number,
  connectionId?: string | null
): Promise<HulyIssue[]> {
  const target = getHulyRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<HulyIssue[]>(
        target,
        'huly.listProjectIssues',
        { projectId, limit, connectionId: connectionId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.huly.listProjectIssues({
        projectId,
        limit,
        connectionId: connectionId ?? undefined
      })
}
