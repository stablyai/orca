import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { NativeChatTurnActivity } from '../../../../shared/native-chat-turn-activity'
import { describeNativeChatActiveTurnLabel } from '../../../../shared/native-chat-turn-status'

/** The live turn's tail line: a spinner plus what the turn is doing right now —
 *  the provider's activity text, else that it is reasoning, else plain "Working…".
 *  The clock lives in the turn bar under the user's message, not here. */
export function NativeChatTurnActivityLine({
  activity,
  thinking
}: {
  activity?: NativeChatTurnActivity | null
  thinking: boolean
}): React.JSX.Element {
  const resolved = describeNativeChatActiveTurnLabel({ activityText: activity?.text, thinking })
  const label =
    resolved.source === 'activity'
      ? resolved.text
      : resolved.key === 'thinking'
        ? translate('components.native-chat.status.thinking', 'Thinking')
        : translate('components.native-chat.status.working', 'Working…')

  return (
    <div
      className="flex min-h-6 items-center gap-1.5 text-sm leading-relaxed text-muted-foreground"
      data-native-chat-turn-activity="true"
      aria-live="polite"
      aria-atomic="true"
    >
      <Loader2 aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
      <span className="min-w-0 flex-1 truncate text-foreground/85">{label}</span>
    </div>
  )
}
