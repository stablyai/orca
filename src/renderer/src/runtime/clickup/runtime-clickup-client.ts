import type { ClickUpApi } from '../../../../preload/api/work-items/clickup-api'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callRuntimeRpc } from '../rpc/calls/runtime-rpc-call'
import { parseClickUpConnectionStatus } from './runtime-clickup-connection-status'

const READ_TIMEOUT_MS = 30_000
const CONNECT_TIMEOUT_MS = 30_000
const ADMIN_TIMEOUT_MS = 15_000

function runtimeClickUpApi(
  target: Extract<RuntimeClientTarget, { kind: 'environment' }>
): ClickUpApi {
  const call = <T>(method: string, params: unknown, timeoutMs: number): Promise<T> =>
    callRuntimeRpc<T>(target, `clickup.${method}`, params, { timeoutMs })
  return {
    connect: (args) => call('connect', args, CONNECT_TIMEOUT_MS),
    disconnect: async () => {
      await call<{ ok: true }>('disconnect', undefined, ADMIN_TIMEOUT_MS)
    },
    selectWorkspace: async (args) =>
      parseClickUpConnectionStatus(await call<unknown>('selectWorkspace', args, ADMIN_TIMEOUT_MS)),
    status: async () =>
      parseClickUpConnectionStatus(await call<unknown>('status', undefined, ADMIN_TIMEOUT_MS)),
    testConnection: () => call('testConnection', undefined, CONNECT_TIMEOUT_MS),
    listTasks: (args) => call('listTasks', args, READ_TIMEOUT_MS),
    searchTasks: (args) => call('searchTasks', args, READ_TIMEOUT_MS),
    getTask: (args) => call('getTask', args, READ_TIMEOUT_MS),
    taskComments: (args) => call('taskComments', args, READ_TIMEOUT_MS),
    addTaskComment: (args) => call('addTaskComment', args, READ_TIMEOUT_MS),
    listStatuses: (args) => call('listStatuses', args, READ_TIMEOUT_MS),
    updateTask: (args) => call('updateTask', args, READ_TIMEOUT_MS)
  }
}

// Why: delegate per call instead of spreading, because the web client's namespace is a lazily resolved proxy.
function localClickUpApi(): ClickUpApi {
  return {
    connect: (args) => window.api.clickup.connect(args),
    disconnect: () => window.api.clickup.disconnect(),
    selectWorkspace: async (args) =>
      parseClickUpConnectionStatus(await window.api.clickup.selectWorkspace(args)),
    status: async () => parseClickUpConnectionStatus(await window.api.clickup.status()),
    testConnection: () => window.api.clickup.testConnection(),
    listTasks: (args) => window.api.clickup.listTasks(args),
    searchTasks: (args) => window.api.clickup.searchTasks(args),
    getTask: (args) => window.api.clickup.getTask(args),
    taskComments: (args) => window.api.clickup.taskComments(args),
    addTaskComment: (args) => window.api.clickup.addTaskComment(args),
    listStatuses: (args) => window.api.clickup.listStatuses(args),
    updateTask: (args) => window.api.clickup.updateTask(args)
  }
}

/** The ClickUp API of whichever runtime owns the credential: this desktop or a remote runtime host. */
export function clickupApiForTarget(target: RuntimeClientTarget): ClickUpApi {
  return target.kind === 'environment' ? runtimeClickUpApi(target) : localClickUpApi()
}
