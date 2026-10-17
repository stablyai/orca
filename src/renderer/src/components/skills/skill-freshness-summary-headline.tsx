import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import type { SkillFreshnessInventory } from '../../../../shared/skill-freshness'
import { translate } from '@/i18n/i18n'

export type FreshnessSummaryKind = 'loading' | 'empty' | 'eligible' | 'current' | 'attention'

export function summarizeInventory(
  inventory: SkillFreshnessInventory | null,
  eligibleCount: number,
  hasBlockedGroup: boolean
): FreshnessSummaryKind {
  if (!inventory) {
    return 'loading'
  }
  if (eligibleCount > 0) {
    return 'eligible'
  }
  if (hasBlockedGroup) {
    return 'attention'
  }
  return inventory.skills.length === 0 ? 'empty' : 'current'
}

// Why: the button stays while any row is updatable, so unticking every row doesn't reflow
// the footer; a disabled "Update 0 skills" would read as a broken count.
export function updateActionLabel(count: number): string {
  if (count === 0) {
    return translate('auto.components.skills.SkillFreshnessUpdateDialog.title', 'Update skills')
  }
  return count === 1
    ? translate(
        'auto.components.skills.SkillFreshnessUpdateDialog.updateActionOne',
        'Update 1 skill'
      )
    : translate(
        'auto.components.skills.SkillFreshnessUpdateDialog.updateActionMany',
        'Update {{value0}} skills',
        { value0: count }
      )
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
