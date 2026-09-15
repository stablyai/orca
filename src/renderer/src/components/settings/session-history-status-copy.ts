import type { AiVaultSearchStatus } from '../../../../shared/ai-vault-search-types'
import { translate } from '@/i18n/i18n'

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

function sweepMessage(status: AiVaultSearchStatus): string {
  if (status.lastSweepCompletedAt === null) {
    // No completed sweep yet, so the denominator is still growing and a percentage would mislead.
    return translate(
      'sessionHistory.status.firstScan',
      'Preparing search · {{indexed}} sessions so far',
      {
        indexed: status.filesIndexed
      }
    )
  }
  const total = status.filesIndexed + status.filesDue + status.filesFailed
  const percent = total > 0 ? Math.floor((status.filesIndexed / total) * 100) : 0
  return translate(
    'sessionHistory.status.progress',
    'Preparing search · {{percent}}% · {{indexed}} of {{total}} sessions',
    { percent, indexed: status.filesIndexed, total }
  )
}

/** The one status sentence every computer row shows, local or paired server. */
export function sessionSearchStatusMessage(status: AiVaultSearchStatus): string {
  if (!status.enabled || status.phase === 'idle' || status.phase === 'closed') {
    return translate(
      'sessionHistory.status.unavailable',
      'Search is not available on this computer right now.'
    )
  }
  if (isSweepingSessionSearch(status)) {
    return sweepMessage(status)
  }
  return translate('sessionHistory.status.upToDate', 'Ready · {{indexed}} sessions searchable', {
    indexed: status.filesIndexed
  })
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

export function sessionSearchOffMessage(): string {
  return translate('sessionHistory.status.off', 'Off')
}

export function sessionSearchReadErrorMessage(): string {
  return translate('sessionHistory.status.error', 'Could not check status. Retrying…')
}

// IPC wraps a rejection's message, so the host-too-old marker arrives inside a longer string.
export function isHostTooOldError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('host-too-old')
}
