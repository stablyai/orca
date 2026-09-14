import { translate } from '@/i18n/i18n'
import {
  describeNativeChatQueuedSend,
  NATIVE_CHAT_TURN_STATUS_COPY
} from '../../../../shared/native-chat-turn-status'
import type { StructuredAgentSessionQueuedSend } from '../../../../shared/structured-agent-session-queued-sends'
import { useNativeChatElapsedSeconds } from './use-native-chat-elapsed-seconds'

/** The wait under a sent message the provider has not started a turn for. Its
 *  clock runs from the acceptance instant the host stamped, so it is re-derived
 *  from an absolute time rather than accumulated, and it shares the transcript's
 *  visibility-gated 1s tick with the turn counter. */
export function NativeChatQueuedSendLine({
  queued
}: {
  queued: StructuredAgentSessionQueuedSend
}): React.JSX.Element {
  const elapsedSeconds = useNativeChatElapsedSeconds(queued.submittedAt, true)
  const { key, duration } = describeNativeChatQueuedSend({
    waitingOn: queued.waitingOn,
    elapsedSeconds
  })
  const label =
    key === 'queuedBehindTurn'
      ? translate(
          'components.native-chat.status.queuedBehindTurn',
          NATIVE_CHAT_TURN_STATUS_COPY.queuedBehindTurn,
          { value0: duration }
        )
      : translate(
          'components.native-chat.status.queuedStarting',
          NATIVE_CHAT_TURN_STATUS_COPY.queuedStarting,
          { value0: duration }
        )
  return (
    <div
      className="flex justify-end text-[11px] text-muted-foreground"
      data-native-chat-queued-send={queued.waitingOn}
      aria-live="polite"
    >
      <span className="max-w-[85%]">{label}</span>
    </div>
  )
}
