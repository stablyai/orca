import type { JiraIssue } from '../../../shared/jira/jira-types'
import { parseJiraStatusError } from '../../../shared/jira/jira-status-error'
import { translate } from '@/i18n/i18n'

export type TaskPageJiraLoadError = {
  title: string
  details: string | null
}

export type TaskPageJiraLoadFailureState = {
  issues: JiraIssue[]
  error: TaskPageJiraLoadError
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : translate(
        'auto.components.taskPageJiraLoadState.failedToLoadIssues',
        'Failed to load Jira issues.'
      )
}

function inferErrorCode(message: string): number | null {
  if (/\bforbidden\b/i.test(message)) {
    return 403
  }
  if (/\bunauthorized\b|\bunauthenticated\b/i.test(message)) {
    return 401
  }
  if (/\btoo many requests\b|\brate limit\b/i.test(message)) {
    return 429
  }
  if (/\bservice unavailable\b/i.test(message)) {
    return 503
  }
  return null
}

function getIssueSearchErrorSummary(message: string, code: number | null): string {
  if (code === 401) {
    return translate(
      'auto.components.taskPageJiraLoadState.authFailed',
      'Jira authentication failed. Reconnect Jira in Settings, then try again.'
    )
  }
  if (code === 403) {
    return translate(
      'auto.components.taskPageJiraLoadState.accessDenied',
      'Jira denied access to this issue search. Check project permissions or try a different JQL query.'
    )
  }
  if (code === 429) {
    return translate(
      'auto.components.taskPageJiraLoadState.rateLimited',
      'Jira rate-limited this issue search. Try again in a moment.'
    )
  }
  if (code !== null && code >= 500) {
    return translate(
      'auto.components.taskPageJiraLoadState.serverError',
      'Jira had a server error while loading issues. Try again in a moment.'
    )
  }
  if (/\bjql\b|\bsyntax\b/i.test(message)) {
    return translate(
      'auto.components.taskPageJiraLoadState.jqlFailed',
      "Jira couldn't run this JQL query. Check the syntax and try again."
    )
  }
  if (/\bnetwork\b|\bfetch failed\b|\btimed? ?out\b|\beconn/i.test(message)) {
    return translate(
      'auto.components.taskPageJiraLoadState.unreachable',
      "Couldn't reach Jira. Check your connection and try again."
    )
  }
  return translate(
    'auto.components.taskPageJiraLoadState.loadFailed',
    "Couldn't load Jira issues. Try again in a moment."
  )
}

/** Jira's reason when it rejected the request as malformed (HTTP 400); null for other failures. */
export function getJiraBadRequestReason(error: unknown): string | null {
  const status = parseJiraStatusError(getErrorMessage(error))
  return status?.code === 400 ? status.details : null
}

export function createTaskPageJiraLoadFailureState(error: unknown): TaskPageJiraLoadFailureState {
  const message = getErrorMessage(error)
  const status = parseJiraStatusError(message)
  const code = status?.code ?? inferErrorCode(message)
  const summary = getIssueSearchErrorSummary(message, code)
  return {
    issues: [],
    error: {
      title:
        code === null
          ? summary
          : translate(
              'auto.components.taskPageJiraLoadState.errorWithCode',
              'Error {{code}}: {{summary}}',
              { code, summary }
            ),
      details: (status?.details ?? message).trim() || null
    }
  }
}
