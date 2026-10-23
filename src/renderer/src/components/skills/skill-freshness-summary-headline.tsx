import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import type { BundledSkillPlan } from '../../../../shared/bundled-skill-plan'
import { summarizeBundledSkillPlan } from '../../../../shared/bundled-skill-summary'
import { translate } from '@/i18n/i18n'

/** Pre-run headline, read from the live plan; once a run starts the dialog reports it. */
export function SummaryHeadline({ plan }: { plan: BundledSkillPlan | null }): React.JSX.Element {
  if (!plan) {
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
  if (plan.skills.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.skills.SkillFreshnessUpdateDialog.none',
          'No installed Orca skills found.'
        )}
      </p>
    )
  }
  const summary = summarizeBundledSkillPlan(plan)
  const updates = summary.skills.filter((skill) => skill.state === 'update').length
  if (summary.badge === 'repair') {
    return (
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" />
        {translate(
          'auto.components.skills.SkillFreshnessUpdateDialog.repair',
          'An earlier update was interrupted. Update to repair it.'
        )}
      </div>
    )
  }
  if (updates > 0) {
    return (
      <p className="text-sm font-medium text-foreground">
        {updates === 1
          ? translate(
              'auto.components.skills.SkillFreshnessUpdateDialog.updateOne',
              '1 update available'
            )
          : translate(
              'auto.components.skills.SkillFreshnessUpdateDialog.updateMany',
              '{{value0}} updates available',
              { value0: updates }
            )}
      </p>
    )
  }
  if (
    summary.skills.some((skill) => skill.locations.some((location) => location.state === 'leave'))
  ) {
    const current = summary.skills.filter((skill) => skill.upToDate).length
    return (
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        {current > 0 ? <CheckCircle2 className="size-4 text-status-success" /> : null}
        {current === 0
          ? translate(
              'auto.components.skills.SkillFreshnessUpdateDialog.noUpdates',
              'No updates available'
            )
          : current === 1
            ? translate(
                'auto.components.skills.SkillFreshnessUpdateDialog.currentOne',
                '1 skill is up to date'
              )
            : translate(
                'auto.components.skills.SkillFreshnessUpdateDialog.currentMany',
                '{{value0}} skills are up to date',
                { value0: current }
              )}
      </div>
    )
  }
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
