import { Info } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { SkillInstallRiskSummary } from './skill-package-install-risk'
import { fileCountLabel } from './skill-display-labels'

function cautionDescription(summary: SkillInstallRiskSummary): string {
  if (summary.selectedSkillCount === 1) {
    return translate(
      'auto.components.skills.install.singleRunnableWarning',
      'This skill includes scripts or binary files.'
    )
  }
  const shownNames = summary.cautionSkillNames.slice(0, 3)
  const remainingCount = summary.cautionSkillNames.length - shownNames.length
  const affected = `${shownNames.join(', ')}${remainingCount ? ` +${remainingCount} more` : ''}`
  return translate(
    'auto.components.skills.install.runnableWarning',
    '{{affectedCount}} of {{selectedCount}} selected skills include scripts or binary files: {{affected}}.',
    {
      affectedCount: summary.cautionSkillNames.length,
      selectedCount: summary.selectedSkillCount,
      affected
    }
  )
}

export function SkillInstallRiskNotice({
  summary
}: {
  summary: SkillInstallRiskSummary
}): React.JSX.Element {
  const hasAdditionalFiles = summary.additionalFileCount > 0
  const title = summary.requiresAcknowledgement
    ? translate(
        'auto.components.skills.install.reviewRunnableFiles',
        'Includes scripts or binary files'
      )
    : hasAdditionalFiles
      ? translate(
          'auto.components.skills.install.reviewSupportingFiles',
          'Review the supporting files'
        )
      : translate('auto.components.skills.install.reviewInstructions', 'About this skill')

  return (
    <section className="space-y-2 rounded-md border border-border p-3" role="note">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Info className="size-4" />
        {title}
      </div>
      {summary.requiresAcknowledgement ? (
        <p className="text-xs leading-5 text-muted-foreground">{cautionDescription(summary)}</p>
      ) : hasAdditionalFiles ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {translate(
            'auto.components.skills.install.supportingFileWarning',
            'The selected skills include {{fileCount}} beyond SKILL.md.',
            { fileCount: fileCountLabel(summary.additionalFileCount) }
          )}
        </p>
      ) : null}
      <p className="text-xs leading-5 text-muted-foreground">
        {translate(
          'auto.components.skills.install.agentAccessWarning',
          'Skills contain instructions your agent may follow. Continue only if you trust the source of this share link.'
        )}
      </p>
    </section>
  )
}
