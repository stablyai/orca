import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import {
  resumeFailureGuidance,
  type ResumeFailureAction
} from '../failures/native-chat-resume-failure-guidance'
import { resumeActivityLabel } from '../tree/native-chat-resume-activity-label'
import type { ResumeToastRow } from './native-chat-resume-toast-view'

function rowActions(row: ResumeToastRow, remote: boolean, t: Translate): ResumeFailureAction[] {
  if (!row.failure) {
    return []
  }
  const guidance = resumeFailureGuidance(row.failure, t)
  const guided = [guidance.primary, guidance.secondary].filter(
    (action): action is ResumeFailureAction =>
      action !== null && !(action === 'open' && row.candidate.surface === 'terminal')
  )
  // A server's chats can only be hidden by closing; this machine's can always be dismissed.
  return remote
    ? guided.filter((action) => action !== 'dismiss')
    : [...guided.filter((action) => action !== 'dismiss'), 'dismiss']
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
  if (row.state === 'stopped') {
    // A plain dot: an empty circle would read as a checkbox, and nothing here is selectable.
    return (
      <span
        role="img"
        aria-label={t('auto.components.NativeChatResumeToast.stateStopped', 'Stopped')}
        className="mt-0.5 inline-flex size-3.5 shrink-0 items-center justify-center"
      >
        <span className="size-1.5 rounded-full bg-muted-foreground/60" />
      </span>
    )
  }
  return (
    <span
      role="img"
      aria-label={t('auto.components.NativeChatResumeToast.stateNeedsYou', 'Needs you')}
      className="mt-0.5 inline-flex shrink-0"
    >
      <AlertCircle className="size-3.5 text-status-warning" />
    </span>
  )
}

export function NativeChatResumeToastRow({
  row,
  name,
  age,
  remote,
  onAction
}: {
  row: ResumeToastRow
  name: string
  age: string
  remote: boolean
  onAction: (action: ResumeFailureAction, sessionId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const actions = rowActions(row, remote, t)
  const reason = row.failure
    ? resumeFailureGuidance(row.failure, t).text
    : resumeActivityLabel(row.candidate.activity, t)?.summary
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
          // One line beside the buttons; a long activity label truncates, its full text on hover.
          <p
            className="mt-0.5 truncate text-[11px] leading-snug text-muted-foreground"
            title={reason}
          >
            {reason}
          </p>
        )}
        {actions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {actions.map((action) => (
              <Button
                key={action}
                // Dismiss deletes the offer, so it sits apart and quieter than the ways to continue.
                variant={
                  action === 'dismiss'
                    ? 'muted-field-icon'
                    : action === actions[0]
                      ? 'outline'
                      : 'ghost'
                }
                size="xs"
                className={action === 'dismiss' ? 'ml-auto' : undefined}
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
