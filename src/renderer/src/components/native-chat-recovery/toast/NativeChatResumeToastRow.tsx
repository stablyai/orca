import { AlertCircle, CheckCircle2, Circle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import {
  resumeFailureGuidance,
  type ResumeFailureAction
} from '../failures/native-chat-resume-failure-guidance'
import { resumeActivityLabel } from '../tree/native-chat-resume-activity-label'
import type { ResumeToastRow } from './native-chat-resume-toast-view'

function rowActions(row: ResumeToastRow, remote: boolean, t: Translate): ResumeFailureAction[] {
  if (row.state !== 'needs-you') {
    return []
  }
  if (!row.failure) {
    return ['retry', 'open']
  }
  const guidance = resumeFailureGuidance(row.failure, t)
  return [guidance.primary, guidance.secondary].filter(
    (action): action is ResumeFailureAction => action !== null && !(remote && action === 'dismiss')
  )
}

function actionLabel(action: ResumeFailureAction, row: ResumeToastRow, t: Translate): string {
  if (action === 'open') {
    return t('auto.components.NativeChatResumeToast.open', 'Open')
  }
  if (action === 'dismiss') {
    return t('auto.components.NativeChatResumeToast.dismiss', 'Dismiss')
  }
  return row.failure
    ? t('auto.components.NativeChatResumeToast.retry', 'Retry')
    : t('auto.components.NativeChatResumeToast.resume', 'Resume')
}

function StateMark({ row }: { row: ResumeToastRow }): React.JSX.Element {
  const t = useTranslate()
  const [Icon, className, label] =
    row.state === 'resumed'
      ? [
          CheckCircle2,
          'text-status-success',
          t('auto.components.NativeChatResumeToast.stateResumed', 'Resumed')
        ]
      : row.state === 'needs-you'
        ? [
            AlertCircle,
            'text-status-warning',
            t('auto.components.NativeChatResumeToast.stateNeedsYou', 'Needs you')
          ]
        : row.state === 'resuming'
          ? [
              Loader2,
              'animate-spin text-muted-foreground motion-reduce:animate-none',
              t('auto.components.NativeChatResumeToast.stateResuming', 'Resuming')
            ]
          : [
              Circle,
              'text-muted-foreground',
              t('auto.components.NativeChatResumeToast.stateStopped', 'Stopped')
            ]
  return (
    <span role="img" aria-label={label} className="mt-0.5 inline-flex shrink-0">
      <Icon className={`size-3.5 ${className}`} />
    </span>
  )
}

export function NativeChatResumeToastRow({
  row,
  name,
  age,
  busy,
  remote,
  onAction
}: {
  row: ResumeToastRow
  name: string
  age: string
  busy: boolean
  remote: boolean
  onAction: (action: ResumeFailureAction, sessionId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const actions = rowActions(row, remote, t)
  const reason = row.failure
    ? resumeFailureGuidance(row.failure, t).text
    : row.state === 'needs-you' || row.state === 'stopped'
      ? resumeActivityLabel(row.candidate.activity, t)?.summary
      : undefined
  return (
    <li className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/40">
      <StateMark row={row} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-foreground/90" title={name}>
            {name}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{age}</span>
        </div>
        {reason && (
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{reason}</p>
        )}
        {actions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {actions.map((action) => (
              <Button
                key={action}
                variant={action === actions[0] ? 'outline' : 'ghost'}
                size="xs"
                // Open is read-only, so it stays available while a resume runs.
                disabled={busy && action !== 'open'}
                aria-label={`${actionLabel(action, row, t)}: ${name}`}
                onClick={() => onAction(action, row.candidate.sessionId)}
              >
                {actionLabel(action, row, t)}
              </Button>
            ))}
          </div>
        )}
      </div>
    </li>
  )
}
