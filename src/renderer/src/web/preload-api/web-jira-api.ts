import type { PreloadApi } from '../../../../preload/api-types'
import { readRuntimeJiraPayload } from '../../runtime/runtime-jira-payload-stream'
import { RuntimeRpcCallError } from '../../runtime/runtime-rpc-client'
import { callRuntimeResult } from './web-runtime-calls'
import { requireActiveEnvironment } from './web-runtime-session'

const JIRA_NETWORK_TIMEOUT_MS = 30_000
const JIRA_SETTINGS_TIMEOUT_MS = 15_000

function jiraCall<TResult>(method: string, params?: unknown, timeoutMs = JIRA_NETWORK_TIMEOUT_MS) {
  return callRuntimeResult<TResult>(`jira.${method}`, params, timeoutMs)
}

// Why: issue bodies with inline images exceed the 1 MiB socket frame, so stream them in chunks.
async function readJiraPayload<TResult>(
  streamMethod: string,
  fallbackMethod: string,
  args: unknown
): Promise<TResult> {
  const target = { kind: 'environment', environmentId: requireActiveEnvironment().id } as const
  try {
    return await readRuntimeJiraPayload<TResult>(target, `jira.${streamMethod}`, args)
  } catch (error) {
    if (!(error instanceof RuntimeRpcCallError) || error.code !== 'method_not_found') {
      throw error
    }
    // Older servers lack payload streaming but return text-only details one-shot.
    return jiraCall<TResult>(fallbackMethod, args)
  }
}

export function createWebJiraApi(): PreloadApi['jira'] {
  return {
    connect: (args) => jiraCall('connect', args),
    disconnect: async (args) => {
      await jiraCall('disconnect', args, JIRA_SETTINGS_TIMEOUT_MS)
    },
    selectSite: (args) => jiraCall('selectSite', args, JIRA_SETTINGS_TIMEOUT_MS),
    status: () => jiraCall('status', undefined, JIRA_SETTINGS_TIMEOUT_MS),
    readStatus: () => jiraCall('readStatus', undefined, JIRA_SETTINGS_TIMEOUT_MS),
    testConnection: (args) => jiraCall('testConnection', args),
    // Why: requestId keys desktop-only IPC cancellation; the server has no cancel method.
    searchIssues: ({ requestId: _requestId, ...args }) => jiraCall('searchIssues', args),
    cancelSearchIssues: () => Promise.resolve(),
    listIssues: (args) => jiraCall('listIssues', args),
    getIssue: (args) => readJiraPayload('getIssueStream', 'getIssue', args),
    lookupIssueSummary: ({ requestId: _requestId, ...args }) =>
      jiraCall('lookupIssueSummary', args),
    cancelIssueSummary: () => Promise.resolve(),
    createIssue: (args) => jiraCall('createIssue', args),
    updateIssue: (args) => jiraCall('updateIssue', args),
    addIssueComment: (args) => jiraCall('addIssueComment', args),
    issueComments: (args) => readJiraPayload('issueCommentsStream', 'issueComments', args),
    listProjects: (args) => jiraCall('listProjects', args),
    listIssueTypes: (args) => jiraCall('listIssueTypes', args),
    listCreateFields: (args) => jiraCall('listCreateFields', args),
    listPriorities: (args) => jiraCall('listPriorities', args),
    listAssignableUsers: (args) => jiraCall('listAssignableUsers', args),
    // Why: servers expose no project-scoped user search; match the remote-environment fallback.
    listAssignableUsersForProject: ({ query, siteId }) =>
      jiraCall('searchUsers', { query, siteId }),
    searchUsers: (args) => jiraCall('searchUsers', args),
    listTransitions: (args) => jiraCall('listTransitions', args),
    getProjectStatusOrder: (args) => jiraCall('getProjectStatusOrder', args)
  }
}
