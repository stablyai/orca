import type { AiVaultSearchStatus } from '../../../../../shared/ai-vault/search/ai-vault-search-types'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
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

/** A whole sweep has finished with nothing left due; failures alone do not hold readiness back. */
export function isSessionSearchIndexReady(status: AiVaultSearchStatus | null): boolean {
  if (!status?.enabled || status.lastSweepCompletedAt === null || status.filesDue > 0) {
    return false
  }
  return status.phase === 'current' || status.phase === 'degraded'
}

export function sessionSearchPollIntervalMs(status: AiVaultSearchStatus | null): number {
  return isSweepingSessionSearch(status)
    ? SESSION_SEARCH_SWEEPING_POLL_MS
    : SESSION_SEARCH_SETTLED_POLL_MS
}

/** Messages are optional on the wire: a host that predates the field reports sessions only. */
function searchableMessage(
  status: AiVaultSearchStatus,
  t: Translate = translate,
  intlLocale?: string
): string {
  const sessions = formatSessionCount(status.filesIndexed, intlLocale)
  if (status.messagesIndexed === undefined) {
    return t('sessionHistory.status.searchableSessions', '{{sessions}} sessions searchable', {
      sessions
    })
  }
  return t(
    'sessionHistory.status.searchable',
    '{{sessions}} sessions · {{messages}} messages searchable',
    { sessions, messages: formatMessageCount(status.messagesIndexed, intlLocale) }
  )
}

/** Show fractions of currently discovered files, never percentages of an unknown total; message counts include only already searchable content. */
function catchingUpMessage(
  status: AiVaultSearchStatus,
  t: Translate = translate,
  intlLocale?: string
): string {
  const indexed = formatSessionCount(status.filesIndexed, intlLocale)
  const total = formatSessionCount(
    status.filesIndexed + status.filesDue + status.filesFailed,
    intlLocale
  )
  if (status.messagesIndexed === undefined) {
    return t(
      'sessionHistory.status.catchingUpSessions',
      '{{indexed}} of {{total}} sessions searchable',
      { indexed, total }
    )
  }
  return t(
    'sessionHistory.status.catchingUp',
    '{{indexed}} of {{total}} sessions · {{messages}} messages searchable',
    { indexed, total, messages: formatMessageCount(status.messagesIndexed, intlLocale) }
  )
}

export function sessionSearchStatusMessage(
  status: AiVaultSearchStatus,
  t: Translate = translate,
  intlLocale?: string
): string {
  if (!status.enabled || status.phase === 'idle' || status.phase === 'closed') {
    return t(
      'sessionHistory.status.unavailable',
      'Search is not available on this computer right now.'
    )
  }
  return isSweepingSessionSearch(status)
    ? catchingUpMessage(status, t, intlLocale)
    : searchableMessage(status, t, intlLocale)
}

export function sessionSearchStatusDetails(
  status: AiVaultSearchStatus | null,
  t: Translate = translate
): string[] {
  if (!status?.enabled) {
    return []
  }
  const lines: string[] = []
  if (status.phase === 'degraded' && status.filesFailed > 0) {
    lines.push(
      t(
        'sessionHistory.status.unreadable',
        '{{failed}} sessions could not be read and will be retried.',
        { failed: status.filesFailed }
      )
    )
  }
  if (status.degradedRoots.length > 0) {
    lines.push(
      t('sessionHistory.status.roots', '{{roots}} session folders could not be checked.', {
        roots: status.degradedRoots.length
      })
    )
  }
  return lines
}

export function sessionSearchCheckingMessage(t: Translate = translate): string {
  return t('sessionHistory.status.checking', 'Checking…')
}

export function sessionSearchReadErrorMessage(t: Translate = translate): string {
  return t('sessionHistory.status.error', 'Could not check status. Retrying…')
}

// IPC embeds host-too-old markers in longer wrapped error messages.
export function isHostTooOldError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('host-too-old')
}
