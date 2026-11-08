import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { requestSkillFreshnessUpdateDialog } from '../skills/skill-freshness-update-dialog'
import { useLatestSkillUpdateRun } from '../skills/skill-update-run-store'
import { updatedSkillsLabel } from '../skills/skill-plan-op-copy'

// Keep reporting after the update dialog closes; statusBarItems must not hide the remaining progress surface.
export function SkillUpdateStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const run = useLatestSkillUpdateRun()

  if (run.state === 'idle') {
    return null
  }

  const segment = (() => {
    if (run.state === 'running') {
      return {
        icon: <Loader2 className="size-3 animate-spin text-muted-foreground" />,
        label: t(
          'auto.components.status.bar.SkillUpdateStatusSegment.runningLabel',
          'Updating skills'
        ),
        tooltip:
          run.names.length === 1
            ? t(
                'auto.components.status.bar.SkillUpdateStatusSegment.runningOne',
                'Updating {{value0}}…',
                { value0: run.names[0] }
              )
            : t(
                'auto.components.status.bar.SkillUpdateStatusSegment.runningSkills',
                'Updating {{count}} skills…',
                { count: run.names.length, defaultValue_one: 'Updating {{count}} skill…' }
              ),
        ariaLabel: t(
          'auto.components.status.bar.SkillUpdateStatusSegment.runningAria',
          'Skills updating. Click to open details.'
        )
      }
    }
    if (run.state === 'done' && run.summary.ok && !run.needsAttention) {
      return {
        icon: <CheckCircle2 className="size-3 text-emerald-500" />,
        label: t(
          'auto.components.status.bar.SkillUpdateStatusSegment.successLabel',
          'Skills updated'
        ),
        tooltip: updatedSkillsLabel(run.summary, t),
        ariaLabel: t(
          'auto.components.status.bar.SkillUpdateStatusSegment.successAria',
          'Skills updated. Click to open details.'
        )
      }
    }
    return {
      icon: <AlertCircle className="size-3 text-yellow-500" />,
      label:
        run.state === 'done' && run.summary.ok && run.needsAttention
          ? t('auto.components.skills.skillPlanOpCopy.needsAttention', 'Needs attention')
          : t(
              'auto.components.status.bar.SkillUpdateStatusSegment.attentionLabel',
              'Skills need attention'
            ),
      tooltip: t(
        'auto.components.status.bar.SkillUpdateStatusSegment.attentionTooltip',
        'Some skill updates were skipped — click to see details'
      ),
      ariaLabel: t(
        'auto.components.status.bar.SkillUpdateStatusSegment.attentionAria',
        'Some skill updates were skipped. Click to open details.'
      )
    }
  })()

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => requestSkillFreshnessUpdateDialog()}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label={segment.ariaLabel}
        >
          {segment.icon}
          {!iconOnly && <span className="text-[11px]">{segment.label}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {segment.tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
