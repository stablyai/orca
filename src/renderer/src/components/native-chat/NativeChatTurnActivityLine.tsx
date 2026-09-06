import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { NativeChatTurnActivity } from './native-chat-turn-activity'
import { nativeChatToolActivityLabel } from './native-chat-tool-activity-label'
import { describeActiveToolCall } from '../../../../shared/native-chat-tool-activity'

function completedToolActivityLabel(activity: Extract<NativeChatTurnActivity, { kind: 'tool' }>) {
  const { preview, toolName } = describeActiveToolCall(activity.call)
  return translate(
    'components.native-chat.activity.continuingAfter',
    'Continuing after {{activity}}…',
    { activity: preview || toolName }
  )
}

export function NativeChatTurnActivityLine({
  activity
}: {
  activity?: NativeChatTurnActivity | null
}): React.JSX.Element {
  const label =
    activity?.kind === 'description'
      ? activity.text
      : activity?.kind === 'tool'
        ? activity.call.state === 'running'
          ? nativeChatToolActivityLabel(activity.call)
          : completedToolActivityLabel(activity)
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
