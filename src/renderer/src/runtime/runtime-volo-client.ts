import type {
  VoloBoard,
  VoloConnectArgs,
  VoloConnectResult,
  VoloConnectionStatus,
  VoloGoogleLoginResult,
  VoloCreateTaskArgs,
  VoloCreateTaskResult,
  VoloMember,
  VoloMutationResult,
  VoloTask,
  VoloTaskFilter,
  VoloTaskUpdate
} from '../../../shared/volo-types'
import { callRuntimeRpc } from './runtime-rpc-client'
import { getVoloRuntimeTarget, type RuntimeVoloSettings } from './runtime-volo-target'

export type { RuntimeVoloSettings } from './runtime-volo-target'

export async function voloStatus(settings: RuntimeVoloSettings): Promise<VoloConnectionStatus> {
  const target = getVoloRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<VoloConnectionStatus>(target, 'volo.status', undefined, { timeoutMs: 15_000 })
    : window.api.volo.status()
}

export async function voloConnect(
  settings: RuntimeVoloSettings,
  args: VoloConnectArgs
): Promise<VoloConnectResult> {
  const target = getVoloRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<VoloConnectResult>(target, 'volo.connect', args, { timeoutMs: 30_000 })
    : window.api.volo.connect(args)
}

export async function voloConnectFromSavedCredentials(
  settings: RuntimeVoloSettings
): Promise<VoloConnectResult> {
  const target = getVoloRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<VoloConnectResult>(target, 'volo.connectFromSavedCredentials', undefined, {
        timeoutMs: 30_000
      })
    : window.api.volo.connectFromSavedCredentials()
}

export async function voloLoginWithGoogle(apiUrl?: string): Promise<VoloGoogleLoginResult> {
  return window.api.volo.loginWithGoogle(apiUrl ? { apiUrl } : undefined)
}

export async function voloDisconnect(settings: RuntimeVoloSettings): Promise<void> {
  const target = getVoloRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await callRuntimeRpc<{ ok: true }>(target, 'volo.disconnect', undefined, { timeoutMs: 15_000 })
    return
  }
  await window.api.volo.disconnect()
}

export async function voloTestConnection(
  settings: RuntimeVoloSettings
): Promise<VoloConnectResult> {
  const target = getVoloRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<VoloConnectResult>(target, 'volo.testConnection', undefined, {
        timeoutMs: 30_000
      })
    : window.api.volo.testConnection()
}

export async function voloListBoards(settings: RuntimeVoloSettings): Promise<VoloBoard[]> {
  const target = getVoloRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<VoloBoard[]>(target, 'volo.listBoards', undefined, { timeoutMs: 30_000 })
    : window.api.volo.listBoards()
}

export async function voloListMembers(
  settings: RuntimeVoloSettings,
  boardId: string
): Promise<VoloMember[]> {
  const target = getVoloRuntimeTarget(settings)
  const args = { boardId }
  return target.kind === 'environment'
    ? callRuntimeRpc<VoloMember[]>(target, 'volo.listMembers', args, { timeoutMs: 30_000 })
    : window.api.volo.listMembers(args)
}

export async function voloListTasks(
  settings: RuntimeVoloSettings,
  boardId: string,
  filter?: VoloTaskFilter
): Promise<VoloTask[]> {
  const target = getVoloRuntimeTarget(settings)
  const args = { boardId, filter }
  return target.kind === 'environment'
    ? callRuntimeRpc<VoloTask[]>(target, 'volo.listTasks', args, { timeoutMs: 30_000 })
    : window.api.volo.listTasks(args)
}

export async function voloGetTask(
  settings: RuntimeVoloSettings,
  taskCode: string
): Promise<VoloTask | null> {
  const target = getVoloRuntimeTarget(settings)
  const args = { taskCode }
  return target.kind === 'environment'
    ? callRuntimeRpc<VoloTask | null>(target, 'volo.getTask', args, { timeoutMs: 30_000 })
    : window.api.volo.getTask(args)
}

export async function voloCreateTask(
  settings: RuntimeVoloSettings,
  args: VoloCreateTaskArgs
): Promise<VoloCreateTaskResult> {
  const target = getVoloRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<VoloCreateTaskResult>(target, 'volo.createTask', args, { timeoutMs: 30_000 })
    : window.api.volo.createTask(args)
}

export async function voloUpdateTask(
  settings: RuntimeVoloSettings,
  boardId: string,
  taskId: string,
  updates: VoloTaskUpdate
): Promise<VoloMutationResult> {
  const target = getVoloRuntimeTarget(settings)
  const args = { boardId, taskId, updates }
  return target.kind === 'environment'
    ? callRuntimeRpc<VoloMutationResult>(target, 'volo.updateTask', args, { timeoutMs: 30_000 })
    : window.api.volo.updateTask(args)
}

export async function voloMoveTask(
  settings: RuntimeVoloSettings,
  boardId: string,
  taskId: string,
  columnId: string
): Promise<VoloMutationResult> {
  const target = getVoloRuntimeTarget(settings)
  const args = { boardId, taskId, columnId }
  return target.kind === 'environment'
    ? callRuntimeRpc<VoloMutationResult>(target, 'volo.moveTask', args, { timeoutMs: 30_000 })
    : window.api.volo.moveTask(args)
}
