import type { DiscoveredSkill } from '../../../../shared/skills'
import { MAX_SKILL_DELETE_BATCH } from '../../../../shared/skill-delete-contract'
import { skillDeletionEligibility } from '../../../../shared/skill-deletion-eligibility'
import { skillDeleteBlockReasonLabel } from './skill-delete-copy'
import {
  addSelectableSkillResults,
  eligibleSkillSelectionCount,
  retainedSkillSelection,
  type SkillSelectionPolicy
} from './skill-selection'

/** No collision key: two rows named `foo` from different roots are two distinct
 *  skills, and both must be independently selectable and reportable. */
const DELETE_SELECTION_POLICY: SkillSelectionPolicy = {
  isEligible: (skill) => skillDeletionEligibility(skill).deletable,
  collisionKey: () => null,
  maxSelection: MAX_SKILL_DELETE_BATCH
}

export function isSkillDeleteEligible(skill: DiscoveredSkill): boolean {
  return DELETE_SELECTION_POLICY.isEligible(skill)
}

/** Advisory client-side reason. The host re-derives the verdict from the
 *  placement set and can refuse a row this reports as deletable. */
export function skillDeleteEligibilityReason(skill: DiscoveredSkill): string | null {
  const eligibility = skillDeletionEligibility(skill)
  return eligibility.deletable ? null : skillDeleteBlockReasonLabel(eligibility.reason)
}

export function eligibleDeleteSkillCount(results: readonly DiscoveredSkill[]): number {
  return eligibleSkillSelectionCount(results, DELETE_SELECTION_POLICY)
}

export function addDeletableSkillResults(
  current: ReadonlySet<string>,
  skills: readonly DiscoveredSkill[],
  results: readonly DiscoveredSkill[]
): Set<string> {
  return addSelectableSkillResults(current, skills, results, DELETE_SELECTION_POLICY)
}

export function retainedDeletableSkillSelection(
  current: Set<string>,
  skills: readonly DiscoveredSkill[]
): Set<string> {
  return retainedSkillSelection(current, skills, DELETE_SELECTION_POLICY)
}
