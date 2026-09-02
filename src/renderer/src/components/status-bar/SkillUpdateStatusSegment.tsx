import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { requestSkillFreshnessUpdateDialog } from '../skills/skill-freshness-update-dialog'
import { useSkillUpdateRun } from '../skills/skill-update-run-store'

// Why: always rendered (not gated by `statusBarItems`). The dialog can be closed
// while the run continues, so this segment is the only surface left reporting it.
export function SkillUpdateStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const run = useSkillUpdateRun()

  if (run.state === 'idle') {
    return null
  }

  const segment = (() => {
    if (run.state === 'running' && run.stopping) {
      // The dialog can be closed while a Stop is still killing the tree; this is
      // then the only surface reporting it, and "Updating skills" would be wrong.
      return {
        icon: <Loader2 className="size-3 animate-spin text-muted-foreground" />,
        label: translate(
          'auto.components.status.bar.SkillUpdateStatusSegment.stoppingLabel',
          'Stopping update'
        ),
        tooltip: translate(
          'auto.components.status.bar.SkillUpdateStatusSegment.stoppingTooltip',
          'Stopping the skill update…'
        ),
        ariaLabel: translate(
          'auto.components.status.bar.SkillUpdateStatusSegment.stoppingAria',
          'Stopping the skill update. Click to open details.'
        )
      }
    }
    if (run.state === 'running') {
      return {
        icon: <Loader2 className="size-3 animate-spin text-muted-foreground" />,
        label: translate(
          'auto.components.status.bar.SkillUpdateStatusSegment.runningLabel',
          'Updating skills'
        ),
        tooltip:
          run.names.length === 1
            ? translate(
                'auto.components.status.bar.SkillUpdateStatusSegment.runningOne',
                'Updating {{value0}}…',
                { value0: run.names[0] }
              )
            : translate(
                'auto.components.status.bar.SkillUpdateStatusSegment.runningMany',
                'Updating {{value0}} skills…',
                { value0: run.names.length }
              ),
        ariaLabel: translate(
          'auto.components.status.bar.SkillUpdateStatusSegment.runningAria',
          'Skills updating. Click to open details.'
        )
      }
    }
    if (run.state === 'success') {
      return {
        icon: <CheckCircle2 className="size-3 text-emerald-500" />,
        label: translate(
          'auto.components.status.bar.SkillUpdateStatusSegment.successLabel',
          'Skills updated'
        ),
        tooltip:
          run.names.length === 1
            ? translate(
                'auto.components.status.bar.SkillUpdateStatusSegment.successOne',
                'Updated {{value0}}',
                { value0: run.names[0] }
              )
            : translate(
                'auto.components.status.bar.SkillUpdateStatusSegment.successMany',
                'Updated {{value0}} skills',
                { value0: run.names.length }
              ),
        ariaLabel: translate(
          'auto.components.status.bar.SkillUpdateStatusSegment.successAria',
          'Skills updated. Click to open details.'
        )
      }
    }
    return {
      icon: <AlertCircle className="size-3 text-yellow-500" />,
      label: translate(
        'auto.components.status.bar.SkillUpdateStatusSegment.errorLabel',
        'Update failed'
      ),
      tooltip: translate(
        'auto.components.status.bar.SkillUpdateStatusSegment.errorTooltip',
        'Skill update failed — click to see details'
      ),
      ariaLabel: translate(
        'auto.components.status.bar.SkillUpdateStatusSegment.errorAria',
        'Skill update failed. Click to open details.'
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
