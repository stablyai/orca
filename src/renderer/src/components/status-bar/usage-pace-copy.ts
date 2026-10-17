import { translate } from '@/i18n/i18n'
import { formatResetDuration } from '../../../../shared/rate-limit-reset-format'
import type { UsagePace } from '../../../../shared/usage-pace'

/** "On pace" / "19% in reserve" / "21% in deficit". */
export function formatUsagePaceDelta(pace: UsagePace): string {
  if (pace.stage === 'on-pace') {
    return translate('auto.components.status.bar.usage.pace.onPace', 'On pace')
  }
  if (pace.stage === 'deficit') {
    return translate('auto.components.status.bar.usage.pace.deficit', '{{value0}}% in deficit', {
      value0: pace.displayDeltaPercent
    })
  }
  return translate('auto.components.status.bar.usage.pace.reserve', '{{value0}}% in reserve', {
    value0: pace.displayDeltaPercent
  })
}

/** "Lasts until reset" / "Runs out in 2h 10m" — what this burn rate implies. */
export function formatUsagePaceOutlook(pace: UsagePace): string {
  if (pace.willLastToReset) {
    return translate('auto.components.status.bar.usage.pace.lasts', 'Lasts until reset')
  }
  if (pace.runsOutInMs === null || pace.runsOutInMs <= 0) {
    return translate('auto.components.status.bar.usage.pace.runsOutNow', 'Runs out now')
  }
  return translate('auto.components.status.bar.usage.pace.runsOut', 'Runs out in {{value0}}', {
    value0: formatResetDuration(pace.runsOutInMs)
  })
}

/** Both halves as one line: "19% in reserve · Lasts until reset". */
export function formatUsagePaceLine(pace: UsagePace): string {
  return `${formatUsagePaceDelta(pace)} · ${formatUsagePaceOutlook(pace)}`
}
