import { ChevronRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  describeNativeChatTurnStatus,
  formatNativeChatDuration,
  NATIVE_CHAT_TURN_STATUS_COPY
} from '../../../../shared/native-chat-turn-status'
import type { AgentTurnOutcome } from '../../../../shared/agent-turn-outcome'
import { useNativeChatElapsedSeconds } from './use-native-chat-elapsed-seconds'

export { formatNativeChatDuration }

// Literal keys with literal fallbacks: a dynamic key registers no catalog reference.
function turnStatusLabel(
  key: ReturnType<typeof describeNativeChatTurnStatus>['key'],
  duration: string
): string {
  switch (key) {
    case 'workedFor':
      return translate(
        'components.native-chat.status.workedFor',
        NATIVE_CHAT_TURN_STATUS_COPY.workedFor,
        { value0: duration }
      )
    case 'interruptedAfter':
      return translate(
        'components.native-chat.status.interruptedAfter',
        NATIVE_CHAT_TURN_STATUS_COPY.interruptedAfter,
        { value0: duration }
      )
    case 'failedAfter':
      return translate(
        'components.native-chat.status.failedAfter',
        NATIVE_CHAT_TURN_STATUS_COPY.failedAfter,
        { value0: duration }
      )
    case 'workingFor':
      return translate(
        'components.native-chat.status.workingFor',
        NATIVE_CHAT_TURN_STATUS_COPY.workingFor,
        { value0: duration }
      )
  }
}

/** The turn bar under the user's message: a running clock while the turn works,
 *  then the settled duration, which toggles the turn's folded detail. */
export function NativeChatWorkingStatus({
  startedAt,
  workedSeconds,
  verdict,
  expanded = false,
  onToggleExpanded
}: {
  startedAt: number | null
  workedSeconds?: number | null
  verdict?: AgentTurnOutcome
  expanded?: boolean
  onToggleExpanded?: () => void
}): React.JSX.Element {
  const elapsedSeconds = useNativeChatElapsedSeconds(startedAt, workedSeconds == null)

  const { key, duration } = describeNativeChatTurnStatus({
    workedSeconds,
    elapsedSeconds,
    verdict
  })
  const label = turnStatusLabel(key, duration)
  // `tabular-nums`: the live clock reflows its own label every second otherwise.
  const className =
    'flex min-h-8 items-center gap-1 border-b border-border text-sm text-chat-foreground-faint tabular-nums'
  const caret =
    workedSeconds != null && onToggleExpanded ? (
      <ChevronRight
        className={cn('size-3.5 transition-transform', expanded && 'rotate-90')}
        aria-hidden="true"
      />
    ) : null
  if (workedSeconds != null && onToggleExpanded) {
    return (
      <button
        type="button"
        data-native-chat-turn-status="settled"
        className={cn(
          className,
          'w-full text-left hover:text-chat-foreground-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70'
        )}
        aria-label={translate(
          'components.native-chat.status.toggleDetails',
          NATIVE_CHAT_TURN_STATUS_COPY.toggleDetails
        )}
        aria-expanded={expanded}
        onClick={onToggleExpanded}
      >
        <span>{label}</span>
        {caret}
      </button>
    )
  }

  return (
    <div
      className={className}
      data-native-chat-turn-status={workedSeconds == null ? 'active' : 'settled'}
      aria-label={translate(
        'components.native-chat.status.responding',
        NATIVE_CHAT_TURN_STATUS_COPY.responding
      )}
    >
      <span>{label}</span>
      {caret}
    </div>
  )
}
