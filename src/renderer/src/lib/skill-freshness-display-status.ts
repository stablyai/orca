import {
  bundledSkillLeftLocations,
  bundledSkillVerdict,
  type SkillFreshnessInventory
} from '../../../shared/skill-freshness'

export type SkillFreshnessDisplayStatus =
  | 'installed'
  | 'up-to-date'
  | 'update-available'
  | 'needs-attention'

const STATUS_BY_VERDICT = {
  update: 'update-available',
  attention: 'needs-attention',
  current: 'up-to-date',
  // Why: with no plan for it yet the only honest answer is presence.
  absent: 'installed'
} as const

export function getSkillFreshnessDisplayStatus(
  inventory: SkillFreshnessInventory | null,
  skillName: string
): SkillFreshnessDisplayStatus {
  const plan = inventory?.skills.find((entry) => entry.name === skillName)
  return STATUS_BY_VERDICT[plan ? bundledSkillVerdict(plan) : 'absent']
}

/**
 * Whether the install leaves some copy of this skill as it is, so the review affordance
 * carries a problem rather than a routine update.
 */
export function hasSkillCopyNeedingAttention(
  inventory: SkillFreshnessInventory | null,
  skillName: string
): boolean {
  const plan = inventory?.skills.find((entry) => entry.name === skillName)
  return plan ? bundledSkillLeftLocations(plan).length > 0 : false
}
