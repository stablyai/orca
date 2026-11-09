import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import type { BundledSkillPlan } from '../../../../shared/bundled-skill-plan'
import { summarizeBundledSkillPlan } from '../../../../shared/bundled-skill-summary'
import { useTranslate } from '@/i18n/use-translate'

/** Pre-run headline, read from the live plan; once a run starts the dialog reports it. */
export function SummaryHeadline({ plan }: { plan: BundledSkillPlan | null }): React.JSX.Element {
  const t = useTranslate()
  if (!plan) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t(
          'auto.components.skills.SkillFreshnessUpdateDialog.checking',
          'Checking installed Orca skills…'
        )}
      </div>
    )
  }
  if (plan.skills.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t(
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
        {t(
          'auto.components.skills.SkillFreshnessUpdateDialog.repair',
          'An earlier update was interrupted. Update to repair it.'
        )}
      </div>
    )
  }
  if (updates > 0) {
    return (
      <p className="text-sm font-medium text-foreground">
        {t(
          'auto.components.skills.SkillFreshnessUpdateDialog.update',
          '{{count}} updates available',
          { count: updates, defaultValue_one: '{{count}} update available' }
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
          ? t('auto.components.skills.SkillFreshnessUpdateDialog.noUpdates', 'No updates available')
          : t(
              'auto.components.skills.SkillFreshnessUpdateDialog.current',
              '{{count}} skills are up to date',
              { count: current, defaultValue_one: '{{count}} skill is up to date' }
            )}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
      <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
      {t(
        'auto.components.skills.SkillFreshnessUpdateDialog.success',
        'All installed Orca skills are up to date.'
      )}
    </div>
  )
}
