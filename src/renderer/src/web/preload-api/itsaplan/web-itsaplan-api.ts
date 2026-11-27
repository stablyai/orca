import type { PreloadApi } from '../../../../../preload/api-types'
import { callRuntimeResult } from '../../runtime/client/web-runtime-calls'

const ITSAPLAN_NETWORK_TIMEOUT_MS = 30_000
const ITSAPLAN_SETTINGS_TIMEOUT_MS = 15_000

function itsaplanCall<TResult>(
  method: string,
  params?: unknown,
  timeoutMs = ITSAPLAN_NETWORK_TIMEOUT_MS
) {
  return callRuntimeResult<TResult>(`itsaplan.${method}`, params, timeoutMs)
}

export function createWebItsaplanApi(): PreloadApi['itsaplan'] {
  return {
    detectApiUrl: (args) => itsaplanCall('detectApiUrl', args),
    connect: (args) => itsaplanCall('connect', args),
    disconnect: async () => {
      await itsaplanCall('disconnect', undefined, ITSAPLAN_SETTINGS_TIMEOUT_MS)
    },
    status: () => itsaplanCall('status', undefined, ITSAPLAN_SETTINGS_TIMEOUT_MS),
    testConnection: () => itsaplanCall('testConnection'),
    listProjects: (args) => itsaplanCall('listProjects', args),
    getProjectMetadata: (args) => itsaplanCall('getProjectMetadata', args),
    listIssues: (args) => itsaplanCall('listIssues', args),
    getIssue: (args) => itsaplanCall('getIssue', args),
    createIssue: (args) => itsaplanCall('createIssue', args),
    updateIssue: (args) => itsaplanCall('updateIssue', args),
    addComment: (args) => itsaplanCall('addComment', args)
  }
}
