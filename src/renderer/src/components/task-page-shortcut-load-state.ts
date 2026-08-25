import type { ShortcutStory } from '../../../shared/shortcut-types'

export type TaskPageShortcutLoadError = {
  title: string
  details: string | null
}

export type TaskPageShortcutLoadFailureState = {
  stories: ShortcutStory[]
  error: TaskPageShortcutLoadError
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to load Shortcut stories.'
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

function getStorySearchErrorSummary(message: string, code: number | null): string {
  if (code === 401) {
    return 'Shortcut authentication failed. Reconnect Shortcut in Settings, then try again.'
  }
  if (code === 403) {
    return 'Shortcut denied access to this story search. Check workspace permissions or try a different query.'
  }
  if (code === 429) {
    return 'Shortcut rate-limited this story search. Try again in a moment.'
  }
  if (code !== null && code >= 500) {
    return 'Shortcut had a server error while loading stories. Try again in a moment.'
  }
  if (/\bquery\b|\bsyntax\b|\bunprocessable\b/i.test(message)) {
    return "Shortcut couldn't run this search query. Check the syntax and try again."
  }
  if (/\bnetwork\b|\bfetch failed\b|\btimed? ?out\b|\beconn/i.test(message)) {
    return "Couldn't reach Shortcut. Check your connection and try again."
  }
  return "Couldn't load Shortcut stories. Try again in a moment."
}

export function createTaskPageShortcutLoadFailureState(
  error: unknown
): TaskPageShortcutLoadFailureState {
  const message = getErrorMessage(error)
  const code = getErrorCode(message)
  const summary = getStorySearchErrorSummary(message, code)
  return {
    stories: [],
    error: {
      title: code === null ? summary : `Error ${code}: ${summary}`,
      details: getErrorDetails(message, code)
    }
  }
}
