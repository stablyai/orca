import { Info, ShieldAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { SkillInstallRiskSummary } from './skill-package-install-risk'
import { fileCountLabel } from './skill-display-labels'

function cautionDescription(summary: SkillInstallRiskSummary, t: Translate = translate): string {
  if (summary.selectedSkillCount === 1) {
    return t(
      'auto.components.skills.install.singleRunnableWarning',
      'This skill includes scripts or binary files.'
    )
  }
  const shownNames = summary.cautionSkillNames.slice(0, 3)
  const remainingCount = summary.cautionSkillNames.length - shownNames.length
  const names = shownNames.join(', ')
  const affected = remainingCount
    ? t('auto.components.skills.install.namesAndMore', '{{names}} +{{count}} more', {
        names,
        count: remainingCount
      })
    : names
  return t(
    'auto.components.skills.install.runnableWarningOfSelected',
    '{{affectedCount}} of {{count}} selected skills include scripts or binary files: {{affected}}.',
    {
      affectedCount: summary.cautionSkillNames.length,
      count: summary.selectedSkillCount,
      affected,
      defaultValue_one:
        '{{affectedCount}} of {{count}} selected skill include scripts or binary files: {{affected}}.'
    }
  )
}

export function SkillInstallRiskNotice({
  summary
}: {
  summary: SkillInstallRiskSummary
}): React.JSX.Element {
  const t = useTranslate()
  const hasAdditionalFiles = summary.additionalFileCount > 0
  const title = summary.requiresAcknowledgement
    ? t('auto.components.skills.install.reviewRunnableFiles', 'Includes scripts or binary files')
    : hasAdditionalFiles
      ? t('auto.components.skills.install.reviewSupportingFiles', 'Review the supporting files')
      : t('auto.components.skills.install.reviewInstructions', 'About this skill')

  return (
    <section
      className={cn(
        'space-y-1.5 rounded-lg border p-3',
        summary.requiresAcknowledgement
          ? 'border-amber-500/30 bg-amber-500/5 text-foreground'
          : 'border-border/50 bg-muted/20 text-muted-foreground'
      )}
      role="note"
    >
      <div
        className={cn(
          'flex items-center gap-2 text-xs font-medium',
          summary.requiresAcknowledgement ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'
        )}
      >
        {summary.requiresAcknowledgement ? (
          <ShieldAlert className="size-4 shrink-0 text-amber-500" />
        ) : (
          <Info className="size-4 shrink-0 text-muted-foreground" />
        )}
        {title}
      </div>
      {summary.requiresAcknowledgement ? (
        <p className="text-xs leading-5 text-muted-foreground">{cautionDescription(summary, t)}</p>
      ) : hasAdditionalFiles ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {t(
            'auto.components.skills.install.supportingFileWarning',
            'The selected skills include {{fileCount}} beyond SKILL.md.',
            { fileCount: fileCountLabel(summary.additionalFileCount, t) }
          )}
        </p>
      ) : null}
      <p className="text-xs leading-5 text-muted-foreground">
        {t(
          'auto.components.skills.install.agentAccessWarning',
          'Skills contain instructions your agent may follow. Continue only if you trust the source of this share link.'
        )}
      </p>
    </section>
  )
}
