import {
  SUPPORTED_GLOBAL_SKILL_TOPOLOGIES,
  type SkillFreshnessInventory
} from '../../../shared/skill-freshness'

export type SkillFreshnessDisplayStatus =
  | 'installed'
  | 'up-to-date'
  | 'update-available'
  | 'needs-attention'

export function getSkillFreshnessDisplayStatus(
  inventory: SkillFreshnessInventory | null,
  skillName: string
): SkillFreshnessDisplayStatus {
  if (inventory?.eligibleUpdateNames.includes(skillName)) {
    return 'update-available'
  }

  let hasPlacement = false
  let hasBlockedCopy = false
  for (const installation of inventory?.installations ?? []) {
    if (installation.name !== skillName) {
      continue
    }
    hasPlacement = true
    if (installation.status !== 'current' && installation.status !== 'foreign') {
      hasBlockedCopy = true
    }
  }
  // Why: with no scan yet (or nothing found) the only honest answer is presence.
  // Reporting attention here would flash amber on every launch before the first scan.
  if (!hasPlacement) {
    return 'installed'
  }
  // Why: no eligible update is not proof a copy is fine — it can equally mean a copy
  // is out of date somewhere the update command cannot reach. Saying "Installed" there
  // reads as all-clear and hides real drift, so that case gets its own attention state.
  return hasBlockedCopy ? 'needs-attention' : 'up-to-date'
}

/**
 * Whether a copy needs the user's own hands — it is not current, and running the update
 * would not resolve it. This is what marks the review affordance as carrying a problem
 * rather than a routine update, so the badge can stay a badge and the dialog explains.
 */
export function hasSkillCopyNeedingAttention(
  inventory: SkillFreshnessInventory | null,
  skillName: string
): boolean {
  return (inventory?.installations ?? []).some(
    (installation) =>
      installation.name === skillName &&
      installation.status !== 'current' &&
      // Why: another ecosystem's same-name skill is nobody's drift to fix. Asking for
      // attention there offers no exit, since the copy is not the user's to remove.
      installation.status !== 'foreign' &&
      // Why: an out-of-date copy the command converges is ordinary work, not a problem.
      !(
        SUPPORTED_GLOBAL_SKILL_TOPOLOGIES.has(installation.topology) &&
        installation.status === 'outdated'
      )
  )
}
