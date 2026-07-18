import type { SkillFreshnessInventory } from '../../../shared/skill-freshness'

export type SkillFreshnessDisplayStatus = 'installed' | 'up-to-date' | 'update-available'

export function getSkillFreshnessDisplayStatus(
  inventory: SkillFreshnessInventory | null,
  skillName: string
): SkillFreshnessDisplayStatus {
  if (inventory?.eligibleUpdateNames.includes(skillName)) {
    return 'update-available'
  }

  let hasPlacement = false
  for (const installation of inventory?.installations ?? []) {
    if (installation.name !== skillName) {
      continue
    }
    hasPlacement = true
    // No eligible update is not proof that a blocked or unrecognized copy is current.
    if (installation.status !== 'current') {
      return 'installed'
    }
  }
  return hasPlacement ? 'up-to-date' : 'installed'
}
