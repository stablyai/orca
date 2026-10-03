import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { NativeChatTurnActivity } from '../../../../shared/native-chat-turn-activity'
import {
  describeNativeChatActiveTurnLabel,
  type NativeChatActiveTurnLabel
} from '../../../../shared/native-chat-turn-status'

// Literal keys with literal fallbacks: a dynamic key registers no catalog reference.
function statusLabel(key: Extract<NativeChatActiveTurnLabel, { source: 'status' }>['key']): string {
  switch (key) {
    case 'thinking':
      return translate('components.native-chat.status.thinking', 'Thinking')
    case 'stopping':
      return translate('components.native-chat.status.stopping', 'Stopping…')
    case 'working':
      return translate('components.native-chat.status.working', 'Working…')
  }
}

/** The live turn's tail line: a spinner plus what the turn is doing right now —
 *  "Stopping…" once the person's Stop is ending it, else the provider's activity text, else
 *  that it is reasoning, else plain "Working…". The clock lives in the turn bar, not here. */
export function NativeChatTurnActivityLine({
  activity,
  thinking,
  stopping = false
}: {
  activity?: NativeChatTurnActivity | null
  thinking: boolean
  stopping?: boolean
}): React.JSX.Element {
  const resolved = describeNativeChatActiveTurnLabel({
    activityText: activity?.text,
    thinking,
    stopping
  })
  const label = resolved.source === 'activity' ? resolved.text : statusLabel(resolved.key)

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
