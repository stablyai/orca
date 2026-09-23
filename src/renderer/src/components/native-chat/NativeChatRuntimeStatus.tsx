import { Loader2, Target } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import type { NativeChatGoal, NativeChatGoalStatus } from './native-chat-runtime-status'

function goalStatusLabel(status: NativeChatGoalStatus): string {
  const labels: Record<NativeChatGoalStatus, string> = {
    active: translate('components.native-chat.goal.active', 'Active'),
    paused: translate('components.native-chat.goal.paused', 'Paused'),
    blocked: translate('components.native-chat.goal.blocked', 'Blocked'),
    complete: translate('components.native-chat.goal.complete', 'Complete'),
    usageLimited: translate('components.native-chat.goal.usageLimited', 'Usage limited'),
    budgetLimited: translate('components.native-chat.goal.budgetLimited', 'Budget spent')
  }
  return labels[status]
}

function goalTime(updatedAt: number): { dateTime: string; label: string } {
  const date = new Date(updatedAt)
  if (Number.isNaN(date.getTime())) {
    return { dateTime: '', label: translate('components.native-chat.goal.updated', 'Updated') }
  }
  return {
    dateTime: date.toISOString(),
    label: translate('components.native-chat.goal.updatedAt', 'Updated {{value0}}', {
      value0: new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(date)
    })
  }
}

export function NativeChatRuntimeStatus(props: {
  goal: NativeChatGoal | null
  compacting: boolean
}): React.JSX.Element | null {
  if (!props.goal && !props.compacting) {
    return null
  }
  const time = props.goal ? goalTime(props.goal.updatedAt) : null
  return (
    <div className="shrink-0 bg-background px-3 pt-2 sm:px-4" data-native-chat-runtime-status>
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-1.5 rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground shadow-xs">
        {props.compacting ? (
          <div className="flex min-w-0 items-center gap-2" data-native-chat-compacting="true">
            <Loader2
              aria-hidden="true"
              className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
            />
            <span className="font-medium text-foreground" role="status" aria-live="polite">
              {translate(
                'components.native-chat.status.compacting',
                'Compacting the conversation…'
              )}
            </span>
          </div>
        ) : null}
        {props.goal && time ? (
          <div className="flex min-w-0 items-center gap-2" data-native-chat-goal-status>
            <Target aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-foreground" title={props.goal.objective}>
              {props.goal.objective}
            </span>
            <Badge variant="outline">{goalStatusLabel(props.goal.status)}</Badge>
            <time
              className="shrink-0 font-mono text-[10px] tabular-nums"
              dateTime={time.dateTime}
              title={time.dateTime}
            >
              {time.label}
            </time>
          </div>
        ) : null}
      </div>
    </div>
  )
}
