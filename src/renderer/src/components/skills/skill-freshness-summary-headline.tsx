import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import type { SkillFreshnessInventory } from '../../../../shared/skill-freshness'
import { translate } from '@/i18n/i18n'

export type FreshnessSummaryKind =
  | 'loading'
  | 'empty'
  | 'eligible'
  | 'current'
  | 'attention'
  | 'scan-incomplete'

export function summarizeInventory(
  inventory: SkillFreshnessInventory | null,
  hasBlockedGroup: boolean,
  hasIncompleteScan: boolean
): FreshnessSummaryKind {
  if (!inventory) {
    return 'loading'
  }
  if (inventory.eligibleUpdateNames.length > 0) {
    return 'eligible'
  }
  // Why: a named skill the update can't converge outranks a coverage gap — the gap
  // says something might be unchecked, the group says something definitely is wrong.
  if (hasBlockedGroup) {
    return 'attention'
  }
  // Why: a fault on the user's disk, or a bound that ended the walk early. Skipping a
  // single folder is not either one — headlining that would put a permanent warning on
  // any ordinary large plugin cache, the unclearable amber this change removes.
  if (hasIncompleteScan) {
    return 'scan-incomplete'
  }
  // Why: ordered after the scan checks so a scan that never completed is not reported
  // as an empty machine — "none found" would be a claim the scan cannot support.
  if (inventory.installations.length === 0) {
    return 'empty'
  }
  return 'current'
}

/** Pre-run headline. Once a run starts, the dialog reports the run instead. */
export function SummaryHeadline({
  kind,
  eligibleCount,
  blockedCount
}: {
  kind: FreshnessSummaryKind
  eligibleCount: number
  blockedCount: number
}): React.JSX.Element {
  if (kind === 'loading') {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {translate(
          'auto.components.skills.SkillFreshnessUpdateDialog.checking',
          'Checking installed Orca skills…'
        )}
      </div>
    )
  }
  if (kind === 'empty') {
    return (
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.skills.SkillFreshnessUpdateDialog.none',
          'No installed Orca skills found.'
        )}
      </p>
    )
  }
  if (kind === 'current') {
    return (
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
        {translate(
          'auto.components.skills.SkillFreshnessUpdateDialog.success',
          'All installed Orca skills are up to date.'
        )}
      </div>
    )
  }
  if (kind === 'attention') {
    // No follow-up sentence: skipped rows open themselves, so the reason is
    // already on screen directly under this headline.
    return (
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" />
        {translate(
          'auto.components.skills.SkillFreshnessUpdateDialog.attention',
          'Some installed Orca skills were left out of the update.'
        )}
      </div>
    )
  }
  if (kind === 'scan-incomplete') {
    // No follow-up sentence, matching 'attention': the skipped folders are listed
    // directly under this headline, so pointing at a details panel would be stale.
    return (
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" />
        {translate(
          'auto.components.skills.SkillFreshnessUpdateDialog.scanIncomplete',
          'Orca could not finish checking plugin-managed skills.'
        )}
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-foreground">
        {eligibleCount === 1
          ? translate(
              'auto.components.skills.SkillFreshnessUpdateDialog.updateOne',
              '1 update available'
            )
          : translate(
              'auto.components.skills.SkillFreshnessUpdateDialog.updateMany',
              '{{value0}} updates available',
              { value0: eligibleCount }
            )}
      </p>
      {blockedCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          {blockedCount === 1
            ? translate(
                'auto.components.skills.SkillFreshnessUpdateDialog.blockedOne',
                "1 skill can't be updated automatically."
              )
            : translate(
                'auto.components.skills.SkillFreshnessUpdateDialog.blockedMany',
                "{{value0}} skills can't be updated automatically.",
                { value0: blockedCount }
              )}
        </p>
      ) : null}
    </div>
  )
}
