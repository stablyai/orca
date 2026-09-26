import type { BusinessmapCard } from '../../../shared/businessmap-types'

export type TaskPageBusinessmapLoadError = {
  title: string
  details: string | null
}

export type TaskPageBusinessmapLoadFailureState = {
  cards: BusinessmapCard[]
  error: TaskPageBusinessmapLoadError
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to load Businessmap cards.'
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

function getCardSearchErrorSummary(message: string, code: number | null): string {
  if (code === 401) {
    return 'Businessmap authentication failed. Reconnect Businessmap in Settings, then try again.'
  }
  if (code === 403) {
    return 'Businessmap denied access to this board. Check board permissions or try another board.'
  }
  if (code === 429) {
    return 'Businessmap rate-limited this card search. Try again in a moment.'
  }
  if (code !== null && code >= 500) {
    return 'Businessmap had a server error while loading cards. Try again in a moment.'
  }
  if (/\bnetwork\b|\bfetch failed\b|\btimed? ?out\b|\beconn/i.test(message)) {
    return "Couldn't reach Businessmap. Check your connection and try again."
  }
  return "Couldn't load Businessmap cards. Try again in a moment."
}

export function createTaskPageBusinessmapLoadFailureState(
  error: unknown
): TaskPageBusinessmapLoadFailureState {
  const message = getErrorMessage(error)
  const code = getErrorCode(message)
  const summary = getCardSearchErrorSummary(message, code)
  return {
    cards: [],
    error: {
      title: code === null ? summary : `Error ${code}: ${summary}`,
      details: getErrorDetails(message, code)
    }
  }
}
