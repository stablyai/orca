import React from 'react'
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import {
  normalizeClaudeCompactMetric,
  type ClaudeCompactMetric,
  type ExplicitClaudeCompactMetric
} from '../../../../shared/claude-compact-metric'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { getClaudeCompactMetricLabel } from './compact-usage-selection'

const EXPLICIT_METRICS: readonly ExplicitClaudeCompactMetric[] = [
  'session',
  'weekly',
  'fableWeekly'
]

export function ClaudeCompactMetricMenu({
  claude,
  value,
  onValueChange
}: {
  claude: ProviderRateLimits
  value: ClaudeCompactMetric
  onValueChange: (value: ClaudeCompactMetric) => void
}): React.JSX.Element {
  const label = translate(
    'auto.components.status.bar.ClaudeSwitcherMenu.compactMetric',
    'Compact metric'
  )

  return (
    <>
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        aria-label={label}
        value={value}
        onValueChange={(nextValue) => onValueChange(normalizeClaudeCompactMetric(nextValue))}
      >
        <DropdownMenuRadioItem value="auto">
          {getClaudeCompactMetricLabel('auto')}
        </DropdownMenuRadioItem>
        {EXPLICIT_METRICS.map((metric) => (
          <DropdownMenuRadioItem
            key={metric}
            value={metric}
            disabled={claude[metric] === null || claude[metric] === undefined}
          >
            {getClaudeCompactMetricLabel(metric)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
    </>
  )
}
