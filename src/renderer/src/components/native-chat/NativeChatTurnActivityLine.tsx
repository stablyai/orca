import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { NativeChatTurnActivity } from '../../../../shared/native-chat-turn-activity'
import {
  describeNativeChatActiveTurnLabel,
  NATIVE_CHAT_TURN_STATUS_COPY,
  type NativeChatTurnStatus
} from '../../../../shared/native-chat-turn-status'
import { useNativeChatElapsedSeconds } from './use-native-chat-elapsed-seconds'

/** The live turn's one indicator: a spinner plus whatever the turn can say about
 *  itself — the provider's activity text, else that it is reasoning, else how
 *  long it has been working. A settled turn keeps its own `NativeChatWorkingStatus`
 *  row; this one is only ever rendered while the turn is in flight. */
export function NativeChatTurnActivityLine({
  activity,
  status
}: {
  activity?: NativeChatTurnActivity | null
  status?: NativeChatTurnStatus | null
}): React.JSX.Element {
  const thinking = status?.thinking === true
  // The clock only ticks when its number is the label; activity text and
  // "Thinking" carry no duration.
  const counting = status != null && !thinking && !activity?.text
  const elapsedSeconds = useNativeChatElapsedSeconds(status?.startedAt ?? null, counting)
  const resolved = describeNativeChatActiveTurnLabel({
    activityText: activity?.text,
    thinking,
    elapsedSeconds
  })
  const label =
    resolved.source === 'activity'
      ? resolved.text
      : status == null
        ? translate('components.native-chat.status.working', 'Working…')
        : resolved.key === 'thinking'
          ? translate(
              'components.native-chat.status.thinking',
              NATIVE_CHAT_TURN_STATUS_COPY.thinking
            )
          : translate(
              'components.native-chat.status.workingFor',
              NATIVE_CHAT_TURN_STATUS_COPY.workingFor,
              { value0: resolved.duration }
            )

  return (
    <div
      className="flex min-h-6 items-center gap-1.5 text-sm leading-relaxed text-muted-foreground"
      data-native-chat-turn-activity="true"
      data-native-chat-turn-status="active"
      aria-live="polite"
      aria-atomic="true"
    >
      <Loader2 aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
      <span className="min-w-0 flex-1 truncate text-foreground/85">{label}</span>
    </div>
  )
}
