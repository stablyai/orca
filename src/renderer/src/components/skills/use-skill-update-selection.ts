import { useState } from 'react'
import type { SkillFreshnessGroupModel } from './skill-freshness-grouping'

export type SkillUpdateSelection = {
  checkboxFor: (group: SkillFreshnessGroupModel) => {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
  }
  reset: () => void
  selectedNames: string[]
  updatableCount: number
}

/**
 * Which updatable skills the next run rewrites. Every row the plan calls an update is
 * Orca's own copy, so all start selected; the user can untick one.
 */
export function useSkillUpdateSelection(
  groups: readonly SkillFreshnessGroupModel[]
): SkillUpdateSelection {
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set())
  const updatable = groups.filter((group) => group.status === 'update-available')
  return {
    checkboxFor: (group) => ({
      checked: !unticked.has(group.name),
      onCheckedChange: (checked) =>
        setUnticked((previous) => {
          const next = new Set(previous)
          if (checked) {
            next.delete(group.name)
          } else {
            next.add(group.name)
          }
          return next
        })
    }),
    reset: () => setUnticked(new Set()),
    selectedNames: updatable
      .filter((group) => !unticked.has(group.name))
      .map((group) => group.name),
    updatableCount: updatable.length
  }
}
