import type { RateLimitWindow } from '../../../../shared/rate-limit-types'
import { clampUsedPercent } from '../../../../shared/usage-percentage-display'

export type UsageSection = {
  label: string
  window: RateLimitWindow
  groupName?: string
}

/** Choose the most consumed window, preserving input order for ties. */
export function getTightestUsageSectionFromSections(sections: UsageSection[]): UsageSection | null {
  if (sections.length === 0) {
    return null
  }
  return sections.reduce((current, candidate) =>
    clampUsedPercent(candidate.window.usedPercent) > clampUsedPercent(current.window.usedPercent)
      ? candidate
      : current
  )
}
