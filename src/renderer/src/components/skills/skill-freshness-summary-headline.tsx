import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import type { SkillFreshnessInventory } from '../../../../shared/skill-freshness'
import { translate } from '@/i18n/i18n'

export type FreshnessSummaryKind = 'loading' | 'empty' | 'eligible' | 'current' | 'attention'

export function summarizeInventory(
  inventory: SkillFreshnessInventory | null,
  hasBlockedGroup: boolean
): FreshnessSummaryKind {
  if (!inventory) {
    return 'loading'
  }
  if (inventory.installations.length === 0) {
    return 'empty'
  }
  if (inventory.eligibleUpdateNames.length > 0) {
    return 'eligible'
  }
  // Why: with nothing eligible, the modal is either genuinely all-clear or has
  // out-of-date skills it can't safely update; the group filter already dropped
  // the up-to-date and unrecognized-only noise, so a blocked group is the signal.
  return hasBlockedGroup ? 'attention' : 'current'
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
