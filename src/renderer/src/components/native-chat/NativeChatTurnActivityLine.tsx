import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { NativeChatTurnActivity } from './native-chat-turn-activity'

export function NativeChatTurnActivityLine({
  activity
}: {
  activity?: NativeChatTurnActivity | null
}): React.JSX.Element {
  const label = activity?.text ?? translate('components.native-chat.status.working', 'Working…')

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
