import type { PullRequestMergeQueueEntry } from '../../../shared/github/pull-request-types'
import { formatResetDuration } from '../../../shared/rate-limit-reset-format'
import { translate } from '@/i18n/i18n'

/** Human place in line, or null when GitHub gave no usable position. */
function queuePlaceText(entry: PullRequestMergeQueueEntry | undefined): string | null {
  const position = entry?.position
  if (typeof position !== 'number' || !Number.isFinite(position) || position < 1) {
    return null
  }
  if (position === 1) {
    return translate(
      'auto.components.github.pr.merge.queue.presentation.e77682f1ad',
      'next to merge'
    )
  }
  return translate(
    'auto.components.github.pr.merge.queue.presentation.54e43b657c',
    '#{{position}} in line',
    { position }
  )
}

/** `estimatedTimeToMerge` is a GraphQL Int in seconds; render it as a compact duration. */
function queueEtaText(entry: PullRequestMergeQueueEntry | undefined): string | null {
  const seconds = entry?.estimatedTimeToMerge
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return null
  }
  return translate(
    'auto.components.github.pr.merge.queue.presentation.aed8678f01',
    '~{{duration}}',
    {
      // Why: the shared formatter floors to whole minutes, so a sub-minute ETA would
      // read "~0m"; clamp to a minute so the copy stays truthful about "very soon".
      duration: formatResetDuration(Math.max(seconds, 60) * 1000)
    }
  )
}

/**
 * Badge/button copy for a PR sitting in the merge queue. Position and ETA are
 * primary copy, not tooltip-only — but every part degrades away independently so
 * a missing field never renders a placeholder.
 */
export function getGitHubPRMergeQueueLabel(entry: PullRequestMergeQueueEntry | undefined): string {
  const queued = translate(
    'auto.components.github.pr.merge.queue.presentation.0cabcd9e02',
    'Queued'
  )
  const parts = [queuePlaceText(entry), queueEtaText(entry)].filter(
    (part): part is string => part !== null
  )
  return parts.length > 0 ? `${queued} · ${parts.join(' · ')}` : queued
}

export function getGitHubPRMergeQueueTooltip(
  entry: PullRequestMergeQueueEntry | undefined
): string {
  const base = translate(
    'auto.components.github.pr.merge.queue.presentation.5c1debcfb8',
    'Added to the GitHub merge queue.'
  )
  const place = queuePlaceText(entry)
  const eta = queueEtaText(entry)
  if (place && eta) {
    return translate(
      'auto.components.github.pr.merge.queue.presentation.6c286b2fe3',
      '{{base}} It is {{place}} (ETA {{eta}}).',
      { base, place, eta }
    )
  }
  if (place) {
    return translate(
      'auto.components.github.pr.merge.queue.presentation.cd9e09f8b7',
      '{{base}} It is {{place}}.',
      { base, place }
    )
  }
  if (eta) {
    return translate(
      'auto.components.github.pr.merge.queue.presentation.d1a73d2387',
      '{{base}} ETA {{eta}}.',
      { base, eta }
    )
  }
  return base
}
