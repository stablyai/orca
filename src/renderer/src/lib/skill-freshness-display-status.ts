import {
  isOrcaSkillLockSource,
  isSkillCopyNeedingAttention,
  isSkillScanIssueNeedingAttention,
  skillPlacementParticipatesInGlobalFreshness,
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
    // Why: a same-named copy Orca did not install is offered unselected in the dialog,
    // but never advertised; "up to date" would be false, so report presence only.
    return inventory.installations.some(
      (installation) =>
        installation.name === skillName && isOrcaSkillLockSource(installation.lockSource)
    )
      ? 'update-available'
      : 'installed'
  }
  let hasPlacement = false
  let hasBlockedCopy = false
  for (const installation of inventory?.installations ?? []) {
    if (installation.name !== skillName) {
      continue
    }
    // Why: a project's or plugin's own copy is outside the global updater's reach, so it
    // can neither stand in as evidence this skill is installed globally nor make the badge
    // amber over drift Orca has no way to fix.
    if (!skillPlacementParticipatesInGlobalFreshness(installation)) {
      continue
    }
    hasPlacement = true
    if (installation.status !== 'current') {
      hasBlockedCopy = true
    }
  }
  // Why: with no scan yet (or nothing found) the only honest answer is presence.
  // Reporting attention here would flash amber on every launch before the first scan.
  if (!hasPlacement) {
    return 'installed'
  }
  // Why: an unreadable plugin path could hide a copy of any known skill, so it stays
  // fail-closed — but only for skills Orca actually found somewhere. Flagging a skill
  // that isn't installed at all blames it for a fault in someone else's plugin.
  if (inventory?.scanIssues.some(isSkillScanIssueNeedingAttention)) {
    return 'needs-attention'
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
  // Why: the same participation filter the status above applies, or an unreadable plugin
  // folder flags a repo-only skill the status calls merely installed.
  const placements = (inventory?.installations ?? []).filter(
    (installation) =>
      installation.name === skillName && skillPlacementParticipatesInGlobalFreshness(installation)
  )
  return (
    (placements.length > 0 &&
      Boolean(inventory?.scanIssues.some(isSkillScanIssueNeedingAttention))) ||
    placements.some(isSkillCopyNeedingAttention)
  )
}
