import type { JiraConnectionStatus, JiraIssue } from '../../../shared/types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { callRuntimeRpc } from './runtime-rpc-client'
import { getJiraRuntimeTarget, type RuntimeJiraSettings } from './runtime-jira-target'

export async function jiraReadStatus(settings: RuntimeJiraSettings): Promise<JiraConnectionStatus> {
  const target = getJiraRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraConnectionStatus>(target, 'jira.readStatus', undefined, {
        timeoutMs: 15_000
      })
    : window.api.jira.readStatus()
}

export async function jiraLookupIssueSummary(
  settings: RuntimeJiraSettings,
  key: string,
  siteId: string,
  signal?: AbortSignal
): Promise<JiraIssue | null> {
  const target = getJiraRuntimeTarget(settings)
  const args = { key, siteId }
  if (target.kind === 'environment') {
    return callRuntimeRpc<JiraIssue | null>(target, 'jira.lookupIssueSummary', args, {
      timeoutMs: 30_000,
      signal
    })
  }
  if (signal?.aborted) {
    throw createSummaryAbortError()
  }
  const requestId = createBrowserUuid()
  const handleAbort = (): void => {
    void window.api.jira.cancelIssueSummary({ requestId }).catch(() => {})
  }
  signal?.addEventListener('abort', handleAbort, { once: true })
  try {
    return await window.api.jira.lookupIssueSummary({ ...args, requestId })
  } finally {
    signal?.removeEventListener('abort', handleAbort)
  }
}

function createSummaryAbortError(): Error {
  const error = new Error('Jira summary lookup aborted')
  error.name = 'AbortError'
  return error
}
