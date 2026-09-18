export type TaskPageMantisBTLoadError = {
  title: string
  details: string | null
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to load MantisBT issues.'
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
    return 'MantisBT authentication failed. Reconnect MantisBT in Settings, then try again.'
  }
  if (code === 403) {
    return 'MantisBT denied access to this issue list. Check project permissions.'
  }
  if (code === 429) {
    return 'MantisBT rate-limited this request. Try again in a moment.'
  }
  if (code !== null && code >= 500) {
    return 'MantisBT had a server error while loading issues. Try again in a moment.'
  }
  if (/\bnetwork\b|\bfetch failed\b|\btimed? ?out\b|\beconn/i.test(message)) {
    return "Couldn't reach MantisBT. Check your connection and try again."
  }
  return "Couldn't load MantisBT issues. Try again in a moment."
}

// Why hasPartialResults: with per-page progress, a fetch that fails partway
// through can still have already shown some real issues (see
// use-task-page-mantisbt-list-effects.ts, which deliberately does not clear
// them) — the generic "couldn't load" summary would then read as if nothing
// loaded, when the list below the banner may already have real issues in it.
export function createTaskPageMantisBTLoadFailureState(
  error: unknown,
  hasPartialResults: boolean
): TaskPageMantisBTLoadError {
  const message = getErrorMessage(error)
  const code = getErrorCode(message)
  const summary = getIssueSearchErrorSummary(message, code)
  const title = code === null ? summary : `Error ${code}: ${summary}`
  return {
    title: hasPartialResults ? `Showing partial results. ${title}` : title,
    details: getErrorDetails(message, code)
  }
}
