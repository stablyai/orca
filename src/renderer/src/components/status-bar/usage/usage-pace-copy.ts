import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { formatResetDuration } from '../../../../../shared/agent-usage/rate-limits/rate-limit-reset-format'
import type { UsagePace } from '../../../../../shared/agent-usage/display/usage-pace'

/** "On pace" / "19% in reserve" / "21% in deficit". */
export function formatUsagePaceDelta(pace: UsagePace, t: Translate = translate): string {
  if (pace.stage === 'on-pace') {
    return t('auto.components.status.bar.usage.pace.onPace', 'On pace')
  }
  if (pace.stage === 'deficit') {
    return t('auto.components.status.bar.usage.pace.deficit', '{{value0}}% in deficit', {
      value0: pace.displayDeltaPercent
    })
  }
  return t('auto.components.status.bar.usage.pace.reserve', '{{value0}}% in reserve', {
    value0: pace.displayDeltaPercent
  })
}

/** "Lasts until reset" / "Runs out in 2h 10m" — what this burn rate implies. */
export function formatUsagePaceOutlook(pace: UsagePace, t: Translate = translate): string {
  if (pace.willLastToReset) {
    return t('auto.components.status.bar.usage.pace.lasts', 'Lasts until reset')
  }
  if (pace.runsOutInMs === null || pace.runsOutInMs <= 0) {
    return t('auto.components.status.bar.usage.pace.runsOutNow', 'Runs out now')
  }
  return t('auto.components.status.bar.usage.pace.runsOut', 'Runs out in {{value0}}', {
    value0: formatResetDuration(pace.runsOutInMs)
  })
}

/** Both halves as one line: "19% in reserve · Lasts until reset". */
export function formatUsagePaceLine(pace: UsagePace, t: Translate = translate): string {
  return `${formatUsagePaceDelta(pace, t)} · ${formatUsagePaceOutlook(pace, t)}`
}
