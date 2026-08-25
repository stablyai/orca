import type { ClickUpComment, ClickUpCommentResult, ClickUpConnectionStatus, ClickUpCreateTaskArgs, ClickUpCreateTaskResult, ClickUpList, ClickUpMutationResult, ClickUpTag, ClickUpTask, ClickUpTaskFilter, ClickUpTaskUpdate, ClickUpUser, ClickUpViewer, ClickUpWorkspaceSelection } from '../../../shared/clickup-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import { isRuntimeProviderSearchQueryWithinLimit } from './runtime-provider-search-bounds'

export type RuntimeClickUpSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | TaskSourceContext
  | null
  | undefined

function isTaskSourceContext(settings: RuntimeClickUpSettings): settings is TaskSourceContext {
  return settings !== null && settings !== undefined && 'kind' in settings
}

function targetFor(settings: RuntimeClickUpSettings): ReturnType<typeof getActiveRuntimeTarget> {
  return getActiveRuntimeTarget(
    isTaskSourceContext(settings) ? getTaskSourceRuntimeSettings(settings) : settings
  )
}

function withLocalTimeout<T>(request: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>
  const rejected = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('ClickUp request timed out.')), timeoutMs)
  })
  return Promise.race([request, rejected]).finally(() => clearTimeout(timeout))
}

export async function clickUpStatus(
  settings: RuntimeClickUpSettings
): Promise<ClickUpConnectionStatus> {
  const target = targetFor(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc(target, 'clickup.status', undefined, { timeoutMs: 15_000 })
    : withLocalTimeout(window.api.clickup.status(), 15_000)
}

export async function clickUpConnect(
  settings: RuntimeClickUpSettings,
  apiToken: string
): Promise<{ ok: true; viewer: ClickUpViewer } | { ok: false; error: string }> {
  const target = targetFor(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc(target, 'clickup.connect', { apiToken }, { timeoutMs: 30_000 })
    : withLocalTimeout(window.api.clickup.connect({ apiToken }), 30_000)
}

export async function clickUpDisconnect(settings: RuntimeClickUpSettings): Promise<void> {
  const target = targetFor(settings)
  if (target.kind === 'environment') {
    await callRuntimeRpc(target, 'clickup.disconnect', undefined, { timeoutMs: 15_000 })
    return
  }
  await withLocalTimeout(window.api.clickup.disconnect(), 15_000)
}

export async function clickUpSelectWorkspace(
  settings: RuntimeClickUpSettings,
  workspaceId: ClickUpWorkspaceSelection
): Promise<ClickUpConnectionStatus> {
  const target = targetFor(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc(target, 'clickup.selectWorkspace', { workspaceId }, { timeoutMs: 15_000 })
    : withLocalTimeout(window.api.clickup.selectWorkspace({ workspaceId }), 15_000)
}

export async function clickUpTestConnection(
  settings: RuntimeClickUpSettings
): Promise<{ ok: true; viewer: ClickUpViewer } | { ok: false; error: string }> {
  const target = targetFor(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc(target, 'clickup.testConnection', undefined, { timeoutMs: 30_000 })
    : withLocalTimeout(window.api.clickup.testConnection(), 30_000)
}

export async function clickUpSearchTasks(
  settings: RuntimeClickUpSettings,
  query: string,
  limit?: number,
  workspaceId?: ClickUpWorkspaceSelection | null
): Promise<ClickUpTask[]> {
  if (!isRuntimeProviderSearchQueryWithinLimit(query)) {
    return []
  }
  const target = targetFor(settings)
  const params = { query, limit, workspaceId: workspaceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc(target, 'clickup.searchTasks', params, { timeoutMs: 60_000 })
    : withLocalTimeout(window.api.clickup.searchTasks(params), 60_000)
}

export async function clickUpListTasks(
  settings: RuntimeClickUpSettings,
  filter?: ClickUpTaskFilter,
  limit?: number,
  workspaceId?: ClickUpWorkspaceSelection | null
): Promise<ClickUpTask[]> {
  const target = targetFor(settings)
  const params = { filter, limit, workspaceId: workspaceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc(target, 'clickup.listTasks', params, { timeoutMs: 60_000 })
    : withLocalTimeout(window.api.clickup.listTasks(params), 60_000)
}

export async function clickUpGetTask(
  settings: RuntimeClickUpSettings,
  taskId: string,
  workspaceId?: string | null
): Promise<ClickUpTask | null> {
  const target = targetFor(settings)
  const params = { taskId, workspaceId: workspaceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc(target, 'clickup.getTask', params, { timeoutMs: 30_000 })
    : withLocalTimeout(window.api.clickup.getTask(params), 30_000)
}

export async function clickUpCreateTask(
  settings: RuntimeClickUpSettings,
  args: ClickUpCreateTaskArgs
): Promise<ClickUpCreateTaskResult> {
  const target = targetFor(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc(target, 'clickup.createTask', args, { timeoutMs: 30_000 })
    : withLocalTimeout(window.api.clickup.createTask(args), 30_000)
}

export async function clickUpUpdateTask(
  settings: RuntimeClickUpSettings,
  taskId: string,
  updates: ClickUpTaskUpdate,
  workspaceId?: string | null
): Promise<ClickUpMutationResult> {
  const target = targetFor(settings)
  const params = { taskId, updates, workspaceId: workspaceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc(target, 'clickup.updateTask', params, { timeoutMs: 30_000 })
    : withLocalTimeout(window.api.clickup.updateTask(params), 30_000)
}

export async function clickUpAddTaskComment(
  settings: RuntimeClickUpSettings,
  taskId: string,
  body: string,
  workspaceId?: string | null
): Promise<ClickUpCommentResult> {
  const target = targetFor(settings)
  const params = { taskId, body, workspaceId: workspaceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc(target, 'clickup.addTaskComment', params, { timeoutMs: 30_000 })
    : withLocalTimeout(window.api.clickup.addTaskComment(params), 30_000)
}

export async function clickUpTaskComments(
  settings: RuntimeClickUpSettings,
  taskId: string,
  workspaceId?: string | null
): Promise<ClickUpComment[]> {
  const target = targetFor(settings)
  const params = { taskId, workspaceId: workspaceId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc(target, 'clickup.taskComments', params, { timeoutMs: 30_000 })
    : withLocalTimeout(window.api.clickup.taskComments(params), 30_000)
}

export async function clickUpListLists(
  settings: RuntimeClickUpSettings,
  workspaceId?: ClickUpWorkspaceSelection | null
): Promise<ClickUpList[]> {
  const target = targetFor(settings)
  const params = workspaceId ? { workspaceId } : undefined
  return target.kind === 'environment'
    ? callRuntimeRpc(target, 'clickup.listLists', params, { timeoutMs: 60_000 })
    : withLocalTimeout(window.api.clickup.listLists(params), 60_000)
}

export async function clickUpListMembers(
  settings: RuntimeClickUpSettings,
  workspaceId?: string | null
): Promise<ClickUpUser[]> {
  const target = targetFor(settings)
  const params = workspaceId ? { workspaceId } : undefined
  return target.kind === 'environment'
    ? callRuntimeRpc(target, 'clickup.listMembers', params, { timeoutMs: 30_000 })
    : withLocalTimeout(window.api.clickup.listMembers(params), 30_000)
}

export async function clickUpListTags(
  settings: RuntimeClickUpSettings,
  workspaceId?: string | null
): Promise<ClickUpTag[]> {
  const target = targetFor(settings)
  const params = workspaceId ? { workspaceId } : undefined
  return target.kind === 'environment'
    ? callRuntimeRpc(target, 'clickup.listTags', params, { timeoutMs: 30_000 })
    : withLocalTimeout(window.api.clickup.listTags(params), 30_000)
}
