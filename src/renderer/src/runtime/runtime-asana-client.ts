import type {
  AsanaComment,
  AsanaConnectionStatus,
  AsanaCreateTaskArgs,
  AsanaCreateTaskResult,
  AsanaMutationResult,
  AsanaProject,
  AsanaSection,
  AsanaTask,
  AsanaTaskFilter,
  AsanaTaskUpdate,
  AsanaUser,
  AsanaViewer,
  AsanaWorkspaceSelection,
  GlobalSettings
} from '../../../shared/types'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'

export type RuntimeAsanaSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | null
  | undefined

export type AsanaConnectResult = { ok: true; viewer: AsanaViewer } | { ok: false; error: string }
export type AsanaCommentResult = { ok: true; id: string } | { ok: false; error: string }

export async function asanaStatus(settings: RuntimeAsanaSettings): Promise<AsanaConnectionStatus> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<AsanaConnectionStatus>(target, 'asana.status', undefined, {
        timeoutMs: 15_000
      })
    : window.api.asana.status()
}

export async function asanaConnect(
  settings: RuntimeAsanaSettings,
  args: { apiToken: string }
): Promise<AsanaConnectResult> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<AsanaConnectResult>(target, 'asana.connect', args, { timeoutMs: 30_000 })
    : window.api.asana.connect(args)
}

export async function asanaDisconnect(
  settings: RuntimeAsanaSettings,
  workspaceId?: string | null
): Promise<void> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await callRuntimeRpc<{ ok: true }>(
      target,
      'asana.disconnect',
      workspaceId ? { workspaceId } : undefined,
      { timeoutMs: 15_000 }
    )
    return
  }
  await window.api.asana.disconnect(workspaceId ? { workspaceId } : undefined)
}

export async function asanaSelectWorkspace(
  settings: RuntimeAsanaSettings,
  workspaceId: AsanaWorkspaceSelection
): Promise<AsanaConnectionStatus> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<AsanaConnectionStatus>(
        target,
        'asana.selectWorkspace',
        { workspaceId },
        { timeoutMs: 15_000 }
      )
    : window.api.asana.selectWorkspace({ workspaceId })
}

export async function asanaTestConnection(
  settings: RuntimeAsanaSettings,
  workspaceId?: string | null
): Promise<AsanaConnectResult> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<AsanaConnectResult>(
        target,
        'asana.testConnection',
        workspaceId ? { workspaceId } : undefined,
        { timeoutMs: 30_000 }
      )
    : window.api.asana.testConnection(workspaceId ? { workspaceId } : undefined)
}

export async function asanaSearchTasks(
  settings: RuntimeAsanaSettings,
  query: string,
  limit?: number,
  workspaceId?: AsanaWorkspaceSelection | null
): Promise<AsanaTask[]> {
  const target = getActiveRuntimeTarget(settings)
  const args = { query, limit, workspaceId: workspaceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<AsanaTask[]>(target, 'asana.searchTasks', args, { timeoutMs: 30_000 })
    : window.api.asana.searchTasks(args)
}

export async function asanaListTasks(
  settings: RuntimeAsanaSettings,
  filter?: AsanaTaskFilter,
  limit?: number,
  workspaceId?: AsanaWorkspaceSelection | null,
  projectId?: string | null
): Promise<AsanaTask[]> {
  const target = getActiveRuntimeTarget(settings)
  const args = {
    filter,
    limit,
    workspaceId: workspaceId ?? undefined,
    projectId: projectId ?? undefined
  }
  return target.kind === 'environment'
    ? callRuntimeRpc<AsanaTask[]>(target, 'asana.listTasks', args, { timeoutMs: 30_000 })
    : window.api.asana.listTasks(args)
}

export async function asanaGetTask(
  settings: RuntimeAsanaSettings,
  gid: string,
  workspaceId?: string | null
): Promise<AsanaTask | null> {
  const target = getActiveRuntimeTarget(settings)
  const args = { gid, workspaceId: workspaceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<AsanaTask | null>(target, 'asana.getTask', args, { timeoutMs: 30_000 })
    : window.api.asana.getTask(args)
}

export async function asanaCreateTask(
  settings: RuntimeAsanaSettings,
  args: AsanaCreateTaskArgs
): Promise<AsanaCreateTaskResult> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<AsanaCreateTaskResult>(target, 'asana.createTask', args, { timeoutMs: 30_000 })
    : window.api.asana.createTask(args)
}

export async function asanaUpdateTask(
  settings: RuntimeAsanaSettings,
  gid: string,
  updates: AsanaTaskUpdate,
  workspaceId?: string | null
): Promise<AsanaMutationResult> {
  const target = getActiveRuntimeTarget(settings)
  const args = { gid, updates, workspaceId: workspaceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<AsanaMutationResult>(target, 'asana.updateTask', args, { timeoutMs: 30_000 })
    : window.api.asana.updateTask(args)
}

export async function asanaAddTaskComment(
  settings: RuntimeAsanaSettings,
  gid: string,
  text: string,
  workspaceId?: string | null
): Promise<AsanaCommentResult> {
  const target = getActiveRuntimeTarget(settings)
  const args = { gid, text, workspaceId: workspaceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<AsanaCommentResult>(target, 'asana.addTaskComment', args, {
        timeoutMs: 30_000
      })
    : window.api.asana.addTaskComment(args)
}

export async function asanaTaskComments(
  settings: RuntimeAsanaSettings,
  gid: string,
  workspaceId?: string | null
): Promise<AsanaComment[]> {
  const target = getActiveRuntimeTarget(settings)
  const args = { gid, workspaceId: workspaceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<AsanaComment[]>(target, 'asana.taskComments', args, { timeoutMs: 30_000 })
    : window.api.asana.taskComments(args)
}

export async function asanaListProjects(
  settings: RuntimeAsanaSettings,
  workspaceId?: AsanaWorkspaceSelection | null
): Promise<AsanaProject[]> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<AsanaProject[]>(
        target,
        'asana.listProjects',
        workspaceId ? { workspaceId } : undefined,
        { timeoutMs: 30_000 }
      )
    : window.api.asana.listProjects(workspaceId ? { workspaceId } : undefined)
}

export async function asanaListSections(
  settings: RuntimeAsanaSettings,
  projectGid: string,
  workspaceId?: string | null
): Promise<AsanaSection[]> {
  const target = getActiveRuntimeTarget(settings)
  const args = { projectGid, workspaceId: workspaceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<AsanaSection[]>(target, 'asana.listSections', args, { timeoutMs: 30_000 })
    : window.api.asana.listSections(args)
}

export async function asanaListAssignableUsers(
  settings: RuntimeAsanaSettings,
  workspaceId?: string | null,
  query?: string
): Promise<AsanaUser[]> {
  const target = getActiveRuntimeTarget(settings)
  const args = { workspaceId: workspaceId ?? undefined, query }
  return target.kind === 'environment'
    ? callRuntimeRpc<AsanaUser[]>(target, 'asana.listAssignableUsers', args, { timeoutMs: 30_000 })
    : window.api.asana.listAssignableUsers(args)
}
