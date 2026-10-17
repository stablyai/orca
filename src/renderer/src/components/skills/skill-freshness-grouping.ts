import {
  bundledSkillVerdict,
  type BundledSkillLocationPlan,
  type SkillFreshnessInventory
} from '../../../../shared/skill-freshness'

export type SkillGroupStatus = 'update-available' | 'cannot-update'

export type SkillFreshnessGroupModel = {
  name: string
  status: SkillGroupStatus
  locations: BundledSkillLocationPlan[]
}

/**
 * The Update skills dialog's rows: every skill the install would update, and every skill
 * it would leave a copy of as it is. Each row is that skill's install plan, so the dialog
 * shows exactly what Update will do.
 *
 * `alwaysIncludeNames` keeps the run's rows: a successful update makes them current, which
 * would otherwise drop them the instant the re-plan lands.
 */
export function groupSkillFreshness(
  inventory: SkillFreshnessInventory,
  alwaysIncludeNames: readonly string[] = []
): SkillFreshnessGroupModel[] {
  const pinned = new Set(alwaysIncludeNames)
  return inventory.skills
    .flatMap((plan) => {
      const verdict = bundledSkillVerdict(plan)
      if (verdict !== 'update' && verdict !== 'attention' && !pinned.has(plan.name)) {
        return []
      }
      return [
        {
          name: plan.name,
          status:
            verdict === 'attention' ? ('cannot-update' as const) : ('update-available' as const),
          locations: [...plan.locations].sort((left, right) =>
            left.path.localeCompare(right.path, 'en')
          )
        }
      ]
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
}
