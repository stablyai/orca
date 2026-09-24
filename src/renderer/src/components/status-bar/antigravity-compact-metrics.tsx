import React from 'react'
import { formatResetDuration } from '../../../../shared/rate-limit-reset-format'
import {
  clampUsedPercent,
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import { getAntigravityGroupShortLabel, sortAntigravityBuckets } from './antigravity-usage-format'
import { getTightestUsageSectionFromSections, type UsageSection } from './usage-section-selection'
import { usageTextColorClass } from './usage-roster-formatting'

export function AntigravityCompactMetrics({
  sections,
  display,
  now
}: {
  sections: UsageSection[]
  display: UsagePercentageDisplay
  now: number
}): React.JSX.Element {
  const groups = new Map<string, UsageSection[]>()
  for (const section of sections) {
    const key = section.groupName ?? ''
    groups.set(key, [...(groups.get(key) ?? []), section])
  }
  return (
    <span className="ml-auto inline-flex min-w-0 shrink-0 items-center gap-1 whitespace-nowrap text-[11px] tabular-nums">
      {[...groups.entries()].map(([groupName, groupSections], groupIndex) => {
        const orderedSections = sortAntigravityBuckets(
          groupSections.map((section) => section.window)
        ).map((window) => groupSections.find((section) => section.window === window)!)
        const tightest = getTightestUsageSectionFromSections(orderedSections)
        if (!tightest) {
          return null
        }
        const reset = tightest.window.resetsAt
          ? formatResetDuration(tightest.window.resetsAt - now)
          : null
        const used = clampUsedPercent(tightest.window.usedPercent)
        const shown = getDisplayedUsagePercentage(tightest.window.usedPercent, display)
        return (
          <React.Fragment key={groupName || 'other'}>
            {groupIndex > 0 ? <span className="text-muted-foreground">|</span> : null}
            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
              <span className="text-muted-foreground">
                {getAntigravityGroupShortLabel(groupName)}
              </span>
              <span className="shrink-0 text-[11px]">
                <span className={`tabular-nums text-[11px] ${usageTextColorClass(used)}`}>
                  {shown}%
                </span>
              </span>
              {reset ? (
                <span className="shrink-0 text-[10px] text-muted-foreground">{reset}</span>
              ) : null}
            </span>
          </React.Fragment>
        )
      })}
    </span>
  )
}
