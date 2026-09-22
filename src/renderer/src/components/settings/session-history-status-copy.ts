import type { AiVaultSearchStatus } from '../../../../shared/ai-vault-search-types'
import { translate } from '@/i18n/i18n'
import { formatMessageCount, formatSessionCount } from './session-search-count-format'

export const SESSION_SEARCH_SWEEPING_POLL_MS = 2_000
export const SESSION_SEARCH_SETTLED_POLL_MS = 10_000

// A pass still has files due, so counts move between polls; a settled index only changes on the next sweep.
export function isSweepingSessionSearch(status: AiVaultSearchStatus | null): boolean {
  if (!status?.enabled) {
    return false
  }
  return status.phase === 'indexing' || (status.phase === 'degraded' && status.filesDue > 0)
}

export function sessionSearchPollIntervalMs(status: AiVaultSearchStatus | null): number {
  return isSweepingSessionSearch(status)
    ? SESSION_SEARCH_SWEEPING_POLL_MS
    : SESSION_SEARCH_SETTLED_POLL_MS
}

/** Messages are optional on the wire: a host that predates the field reports sessions only. */
function searchableMessage(status: AiVaultSearchStatus): string {
  const sessions = formatSessionCount(status.filesIndexed)
  if (status.messagesIndexed === undefined) {
    return translate(
      'sessionHistory.status.searchableSessions',
      '{{sessions}} sessions searchable',
      {
        sessions
      }
    )
  }
  return translate(
    'sessionHistory.status.searchable',
    '{{sessions}} sessions · {{messages}} messages searchable',
    { sessions, messages: formatMessageCount(status.messagesIndexed) }
  )
}

/**
 * A sweep in flight. The denominator is what the pass knows about so far, which
 * is why it is a plain fraction and never a percentage. Messages are the count
 * already searchable, not a total: nothing knows how many a file holds until it
 * is read.
 */
function catchingUpMessage(status: AiVaultSearchStatus): string {
  const indexed = formatSessionCount(status.filesIndexed)
  const total = formatSessionCount(status.filesIndexed + status.filesDue + status.filesFailed)
  if (status.messagesIndexed === undefined) {
    return translate(
      'sessionHistory.status.catchingUpSessions',
      '{{indexed}} of {{total}} sessions searchable',
      { indexed, total }
    )
  }
  return translate(
    'sessionHistory.status.catchingUp',
    '{{indexed}} of {{total}} sessions · {{messages}} messages searchable',
    { indexed, total, messages: formatMessageCount(status.messagesIndexed) }
  )
}

/** The one status sentence a computer row shows while its search is on. */
export function sessionSearchStatusMessage(status: AiVaultSearchStatus): string {
  if (!status.enabled || status.phase === 'idle' || status.phase === 'closed') {
    return translate(
      'sessionHistory.status.unavailable',
      'Search is not available on this computer right now.'
    )
  }
  return isSweepingSessionSearch(status) ? catchingUpMessage(status) : searchableMessage(status)
}

/** Lines shown under the status sentence when something needs the user's attention. */
export function sessionSearchStatusDetails(status: AiVaultSearchStatus | null): string[] {
  if (!status?.enabled) {
    return []
  }
  const lines: string[] = []
  if (status.phase === 'degraded' && status.filesFailed > 0) {
    lines.push(
      translate(
        'sessionHistory.status.unreadable',
        '{{failed}} sessions could not be read and will be retried.',
        { failed: status.filesFailed }
      )
    )
  }
  if (status.degradedRoots.length > 0) {
    lines.push(
      translate('sessionHistory.status.roots', '{{roots}} session folders could not be checked.', {
        roots: status.degradedRoots.length
      })
    )
  }
  return lines
}

export function sessionSearchCheckingMessage(): string {
  return translate('sessionHistory.status.checking', 'Checking…')
}

export function sessionSearchReadErrorMessage(): string {
  return translate('sessionHistory.status.error', 'Could not check status. Retrying…')
}

// IPC wraps a rejection's message, so the host-too-old marker arrives inside a longer string.
export function isHostTooOldError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('host-too-old')
}
