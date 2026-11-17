// A minimized "Move to this computer" card: the current step (or the result) in the status bar,
// like the app update's segment. Clicking it brings the card back.
import React from 'react'
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { setMoveMinimized, useCloudMoveState } from '@/lib/orca-cloud/orca-cloud-move-store'
import { cloudMoveStepLabel } from '@/components/orca-cloud/cloud-move-copy'
import { StatusBarCardToggle } from '../StatusBarCardToggle'

export function CloudMoveStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const state = useCloudMoveState()
  if (
    (state.stage !== 'running' && state.stage !== 'done' && state.stage !== 'failed') ||
    !state.minimized
  ) {
    return null
  }
  const segment =
    state.stage === 'running'
      ? {
          icon: <Loader2 className="size-3 motion-safe:animate-spin text-muted-foreground" />,
          label: cloudMoveStepLabel(state.step, t),
          tooltip: t('orcaCloudMove.segment.running', 'Moving {{name}} · {{step}}', {
            name: state.name,
            step: cloudMoveStepLabel(state.step, t)
          })
        }
      : state.stage === 'done'
        ? {
            icon: <CheckCircle2 className="size-3 text-emerald-500" />,
            label: t('orcaCloudMove.segment.doneLabel', 'Moved'),
            tooltip: t('orcaCloudMove.notice.done', '{{name}} is on this computer', {
              name: state.name
            })
          }
        : {
            icon: <AlertCircle className="size-3 text-yellow-500" />,
            label: t('orcaCloudMove.segment.failedLabel', 'Move failed'),
            tooltip: t('orcaCloudMove.title.failed', 'Couldn’t move {{name}}', { name: state.name })
          }
  return (
    <StatusBarCardToggle
      icon={segment.icon}
      label={segment.label}
      tooltip={segment.tooltip}
      ariaLabel={t('orcaCloudMove.segment.aria', '{{status}}. Click to expand.', {
        status: segment.tooltip
      })}
      expanded={false}
      iconOnly={iconOnly}
      onToggle={() => setMoveMinimized(false)}
    />
  )
}
