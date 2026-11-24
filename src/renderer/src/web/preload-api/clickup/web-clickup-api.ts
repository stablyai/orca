import type { PreloadApi } from '../../../../../preload/api-types'
import { callRuntimeResult } from '../../runtime/client/web-runtime-calls'

const CLICKUP_NETWORK_TIMEOUT_MS = 30_000
const CLICKUP_ADMIN_TIMEOUT_MS = 15_000

function clickupCall<TResult>(
  method: string,
  params?: unknown,
  timeoutMs = CLICKUP_NETWORK_TIMEOUT_MS
) {
  return callRuntimeResult<TResult>(`clickup.${method}`, params, timeoutMs)
}

export function createWebClickUpApi(): PreloadApi['clickup'] {
  return {
    connect: (args) => clickupCall('connect', args),
    disconnect: async () => {
      await clickupCall('disconnect', undefined, CLICKUP_ADMIN_TIMEOUT_MS)
    },
    selectWorkspace: (args) => clickupCall('selectWorkspace', args, CLICKUP_ADMIN_TIMEOUT_MS),
    status: () => clickupCall('status', undefined, CLICKUP_ADMIN_TIMEOUT_MS),
    testConnection: () => clickupCall('testConnection'),
    // Why: requestId keys desktop-only IPC cancellation; the server has no cancel method.
    searchTasks: ({ requestId: _requestId, ...args }) => clickupCall('searchTasks', args),
    cancelSearchTasks: () => Promise.resolve(),
    listTasks: (args) => clickupCall('listTasks', args),
    getTask: (args) => clickupCall('getTask', args),
    taskComments: (args) => clickupCall('taskComments', args),
    addTaskComment: (args) => clickupCall('addTaskComment', args),
    listStatuses: (args) => clickupCall('listStatuses', args),
    updateTask: (args) => clickupCall('updateTask', args)
  }
}
