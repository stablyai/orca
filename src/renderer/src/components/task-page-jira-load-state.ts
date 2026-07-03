import type { JiraIssue } from '../../../shared/types'

export type TaskPageJiraLoadError = {
  title: string
  details: string | null
}

export type TaskPageJiraLoadFailureState = {
  issues: JiraIssue[]
  error: TaskPageJiraLoadError
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to load Jira issues.'
}

function getErrorCode(message: string): number | null {
  const explicit = /^Error\s+(\d{3})\b/i.exec(message)?.[1]
  if (explicit) {
    return Number(explicit)
  }
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

function getErrorDetails(message: string, code: number | null): string | null {
  const normalized =
    code === null ? message : message.replace(new RegExp(`^Error\\s+${code}:\\s*`, 'i'), '')
  return normalized.trim() || null
}

function getIssueSearchErrorSummary(message: string, code: number | null): string {
  if (code === 401) {
    return 'Jira authentication failed. Reconnect Jira in Settings, then try again.'
  }
  if (code === 403) {
    return 'Jira denied access to this issue search. Check project permissions or try a different JQL query.'
  }
  if (code === 429) {
    return 'Jira rate-limited this issue search. Try again in a moment.'
  }
  if (code !== null && code >= 500) {
    return 'Jira had a server error while loading issues. Try again in a moment.'
  }
  if (/\bjql\b|\bsyntax\b/i.test(message)) {
    return "Jira couldn't run this JQL query. Check the syntax and try again."
  }
  if (/\bnetwork\b|\bfetch failed\b|\btimed? ?out\b|\beconn/i.test(message)) {
    return "Couldn't reach Jira. Check your connection and try again."
  }
  return "Couldn't load Jira issues. Try again in a moment."
}

export function createTaskPageJiraLoadFailureState(error: unknown): TaskPageJiraLoadFailureState {
  const message = getErrorMessage(error)
  const code = getErrorCode(message)
  const summary = getIssueSearchErrorSummary(message, code)
  return {
    issues: [],
    error: {
      title: code === null ? summary : `Error ${code}: ${summary}`,
      details: getErrorDetails(message, code)
    }
  }
}
