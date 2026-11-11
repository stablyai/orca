// Display helpers for a sleeping workspace's read-only copy (owner asleep view and team read view).
import { translate } from '@/i18n/i18n'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import type { Translate } from '@/i18n/use-translate'
import { formatRelative } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import type { ReadSnapshotAgentStatus } from '../../../../../shared/cloud-workspaces/read-snapshot'

// Intl formatter caches key on option identity, so this must be a module constant.
const ABSOLUTE: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }

/**
 * "As of" parts: relative for the label, absolute (glossary dateStyle medium) for hover. A copy
 * from the last minute (the one Sleep just saved) reads "just now", not a ticking second count.
 */
export function asOfParts(at: number, now: number): { relative: string; absolute: string } {
  const relative =
    Math.abs(now - at) < 60_000
      ? translate('components.orcaCloud.read.justNow', 'just now')
      : formatRelative(at, now)
  return { relative, absolute: uiDateTimeFormat(ABSOLUTE).format(at) }
}

export type ChecksTone = 'success' | 'failure' | 'pending' | 'neutral'

/** Check states arrive as free text from the sandbox; anything unknown reads as neutral. */
export function checksTone(status: string | null): ChecksTone {
  switch ((status ?? '').toLowerCase()) {
    case 'success':
    case 'passed':
    case 'passing':
      return 'success'
    case 'failure':
    case 'failed':
    case 'failing':
    case 'error':
      return 'failure'
    case 'pending':
    case 'running':
    case 'in_progress':
    case 'queued':
      return 'pending'
    default:
      return 'neutral'
  }
}

export function checksLabel(tone: ChecksTone, t: Translate): string {
  switch (tone) {
    case 'success':
      return t('components.orcaCloud.read.checksPassed', 'Checks passed')
    case 'failure':
      return t('components.orcaCloud.read.checksFailed', 'Checks failed')
    case 'pending':
      return t('components.orcaCloud.read.checksPending', 'Checks running')
    case 'neutral':
      return t('components.orcaCloud.read.checksNone', 'No checks')
  }
}

/** Where the agent was when the workspace went to sleep. */
export function agentStatusLabel(
  status: ReadSnapshotAgentStatus,
  turnOutcome: string | null,
  t: Translate
): string {
  switch (status) {
    case 'working':
      return t('components.orcaCloud.read.agentWorking', 'Was working')
    case 'attention':
      return t('components.orcaCloud.read.agentAttention', 'Needs input')
    case 'idle':
      return turnOutcome
        ? t('components.orcaCloud.read.agentDone', 'Done')
        : t('components.orcaCloud.read.agentIdle', 'Idle')
    case 'unknown':
      return t('components.orcaCloud.read.agentUnknown', 'Status unknown')
  }
}

export function prStateLabel(state: string, t: Translate): string {
  switch (state.toLowerCase()) {
    case 'open':
      return t('components.orcaCloud.read.prOpen', 'Open')
    case 'draft':
      return t('components.orcaCloud.read.prDraft', 'Draft')
    case 'merged':
      return t('components.orcaCloud.read.prMerged', 'Merged')
    case 'closed':
      return t('components.orcaCloud.read.prClosed', 'Closed')
    default:
      return state
  }
}
