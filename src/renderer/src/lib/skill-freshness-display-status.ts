import type { BundledSkillPlan } from '../../../shared/bundled-skill-plan'
import {
  bundledSkillPlanState,
  type BundledSkillPlanState
} from '../../../shared/bundled-skill-summary'

export type SkillFreshnessDisplayStatus =
  | 'installed'
  | 'up-to-date'
  | 'update-available'
  | 'needs-attention'

function planState(plan: BundledSkillPlan | null, skillName: string): BundledSkillPlanState | null {
  const entry = plan?.skills.find((skill) => skill.name === skillName)
  return entry ? bundledSkillPlanState(entry) : null
}

export function getSkillFreshnessDisplayStatus(
  plan: BundledSkillPlan | null,
  skillName: string
): SkillFreshnessDisplayStatus {
  switch (planState(plan, skillName)) {
    // Why: no plan yet, or no copy of Orca's here; the only honest answer is presence.
    case null:
      return 'installed'
    case 'update':
      return 'update-available'
    case 'repair':
    case 'attention':
      return 'needs-attention'
    // Why: linking a newly detected agent is "Install for <agent>", not a stale skill.
    case 'install':
    case 'current':
      return 'up-to-date'
  }
}

/** Whether the Update skills dialog has anything to show or do for this skill. */
export function skillPlanHasDetails(plan: BundledSkillPlan | null, skillName: string): boolean {
  const state = planState(plan, skillName)
  return state !== null && state !== 'current'
}

/** A copy the update leaves for the user, or an interrupted update to repair. */
export function hasSkillCopyNeedingAttention(
  plan: BundledSkillPlan | null,
  skillName: string
): boolean {
  return getSkillFreshnessDisplayStatus(plan, skillName) === 'needs-attention'
}
