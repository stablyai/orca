import type { UsageRange } from '../../../../shared/usage-range'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { translate } from '@/i18n/i18n'

const OVERVIEW_RANGES = ['today', '7d', '30d', 'all'] as const

/** Emits only supported overview ranges while leaving selection state with the parent. */
export function UsageOverviewRangePicker({
  range,
  onChange
}: {
  range: UsageRange
  onChange: (range: UsageRange) => void
}): React.JSX.Element {
  const labels = {
    today: translate('usage.range.today', 'Today'),
    '7d': translate('auto.components.stats.CodexUsagePane.rangeLast7Days', 'Last 7 days'),
    '30d': translate('auto.components.stats.CodexUsagePane.rangeLast30Days', 'Last 30 days'),
    all: translate('auto.components.stats.CodexUsagePane.rangeAllTime', 'All time')
  }
  return (
    <Select
      value={range}
      onValueChange={(value) => {
        const selected = OVERVIEW_RANGES.find((candidate) => candidate === value)
        if (selected) {
          onChange(selected)
        }
      }}
    >
      <SelectTrigger size="sm" aria-label={translate('usage.overview.range', 'Usage time range')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {OVERVIEW_RANGES.map((value) => (
          <SelectItem key={value} value={value}>
            {labels[value]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
