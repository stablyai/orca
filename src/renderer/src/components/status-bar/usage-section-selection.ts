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

/** Groups by quota pool in first-seen order; ungrouped entries share one unnamed group. */
export function groupUsageSections<T extends { groupName?: string }>(
  entries: readonly T[]
): { groupName: string | undefined; entries: T[] }[] {
  const groups = new Map<string | undefined, T[]>()
  for (const entry of entries) {
    groups.set(entry.groupName, [...(groups.get(entry.groupName) ?? []), entry])
  }
  return [...groups].map(([groupName, grouped]) => ({ groupName, entries: grouped }))
}

/** Initials of a pool name for tight status-bar space, e.g. "Claude and GPT models" -> "C/G". */
export function getUsageGroupShortLabel(groupName: string): string {
  const initials = groupName
    .split(/\s+/)
    .filter((word) => word && !/^(and|models?)$/i.test(word))
    .map((word) => word.charAt(0).toUpperCase())
  return initials.length > 0 ? initials.join('/') : groupName
}
