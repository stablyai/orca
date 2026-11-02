import { useState } from 'react'
import type { SkillFreshnessGroupModel } from './skill-freshness-grouping'

export type SkillUpdateSelection = {
  checkboxFor: (group: SkillFreshnessGroupModel) => {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
  }
  reset: () => void
  selectedNames: string[]
  ownedCount: number
  unselectedForeignCount: number
}

// Why: a choice is consent for the copy the user saw; if a re-scan finds a different
// install source, the choice lapses back to the ownership default.
function choiceKey(group: SkillFreshnessGroupModel): string {
  return `${group.name}\0${group.lockSource ?? ''}`
}

/**
 * Which updatable skills the next run rewrites. Orca's own skills are preselected;
 * a same-named copy from elsewhere is only replaced once the user ticks it.
 */
export function useSkillUpdateSelection(
  groups: readonly SkillFreshnessGroupModel[]
): SkillUpdateSelection {
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(new Map())
  const isSelected = (group: SkillFreshnessGroupModel): boolean =>
    choices.get(choiceKey(group)) ?? group.orcaOwned
  const updatable = groups.filter((group) => group.status === 'update-available')
  return {
    checkboxFor: (group) => ({
      checked: isSelected(group),
      onCheckedChange: (checked) =>
        setChoices((previous) => new Map(previous).set(choiceKey(group), checked))
    }),
    reset: () => setChoices(new Map()),
    selectedNames: updatable.filter(isSelected).map((group) => group.name),
    ownedCount: updatable.filter((group) => group.orcaOwned).length,
    unselectedForeignCount: updatable.filter((group) => !group.orcaOwned && !isSelected(group))
      .length
  }
}
