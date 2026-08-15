import type { JiraIssue, JiraSiteSelection } from '../../../shared/jira-types'
import { createBrowserUuid } from '@/lib/browser-uuid'

type LocalJiraSearchArgs = { jql: string; limit?: number; siteId?: JiraSiteSelection }

function createJiraSearchAbortError(): Error {
  const error = new Error('Jira search aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Run a local Jira search that the main process can cancel.
 *
 * Without the cancel round-trip a superseded keystroke keeps its slot in the shared Jira request
 * pool until the abandoned query drains, which is what stalls the next search.
 */
export async function searchLocalJiraIssues(
  args: LocalJiraSearchArgs,
  signal: AbortSignal
): Promise<JiraIssue[]> {
  if (signal.aborted) {
    throw createJiraSearchAbortError()
  }
  const requestId = createBrowserUuid()
  const handleAbort = (): void => {
    void window.api.jira.cancelSearchIssues({ requestId }).catch(() => {})
  }
  signal.addEventListener('abort', handleAbort, { once: true })
  try {
    const issues = await window.api.jira.searchIssues({ ...args, requestId })
    // Why: cancel can race ahead of main-process registration; drop late successes.
    if (signal.aborted) {
      throw createJiraSearchAbortError()
    }
    return issues
  } finally {
    signal.removeEventListener('abort', handleAbort)
  }
}
