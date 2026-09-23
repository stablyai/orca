import { translate } from '@/i18n/i18n'
import { NativeChatToolRunIcon } from './NativeChatToolIcon'

/**
 * The transcript tail row for a pane whose agent has stopped and is waiting on
 * the reader. Distinct from NativeChatAwaitingInputRow, which stands in for one
 * question tool call and quotes it: this row reports the pane's own state, which
 * is all a terminal-backed pane can know when the prompt itself is on the TTY.
 *
 * No spinner: nothing is running, and a spinning row is what made a blocked
 * agent look busy.
 */
export function NativeChatAgentWaitingRow(): React.JSX.Element {
  const label = translate('components.native-chat.status.waitingForUser', 'Waiting for your input')
  return (
    <div
      className="flex min-h-6 items-center gap-1.5 text-sm leading-relaxed text-muted-foreground"
      data-native-chat-agent-state="waiting-for-user"
      aria-live="polite"
      aria-atomic="true"
    >
      <NativeChatToolRunIcon iconName="message-square-more" className="text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-foreground/85">{label}</span>
    </div>
  )
}
