import { translate } from '@/i18n/i18n'
import { NATIVE_CHAT_TOOL_ACTIVITY_COPY } from '../../../../shared/native-chat-tool-activity'

/** The settled header's quiet count of calls that did not succeed. A call a stop cut short is
 *  counted apart from a failure: it did not fail, it was not let finish. */
export function NativeChatToolRunCallCounts({
  failed,
  interrupted
}: {
  failed: number
  interrupted: number
}): React.JSX.Element | null {
  const marks = [
    failed > 0
      ? {
          text: translate(
            'components.native-chat.tool.failedCount',
            NATIVE_CHAT_TOOL_ACTIVITY_COPY.failedCount,
            { value0: failed }
          ),
          label: translate(
            'components.native-chat.tool.failedCallsLabel',
            NATIVE_CHAT_TOOL_ACTIVITY_COPY.failedCallsLabel,
            { value0: failed }
          )
        }
      : null,
    interrupted > 0
      ? {
          text: translate(
            'components.native-chat.tool.interruptedCount',
            NATIVE_CHAT_TOOL_ACTIVITY_COPY.interruptedCount,
            { value0: interrupted }
          ),
          label: translate(
            'components.native-chat.tool.interruptedCallsLabel',
            NATIVE_CHAT_TOOL_ACTIVITY_COPY.interruptedCallsLabel,
            { value0: interrupted }
          )
        }
      : null
  ].filter((mark) => mark !== null)
  if (marks.length === 0) {
    return null
  }
  return (
    /* Outside the truncating member list, so the one thing the reader cannot
       afford to miss survives a pane too narrow to print it. Quiet text in the
       header's own type, not a destructive tint or a swapped glyph: a tool error
       is routine work, and the line's own detail is one click away. */
    <span
      aria-label={marks.map((mark) => mark.label).join(', ')}
      className="shrink-0 font-sans text-xs tabular-nums text-chat-foreground-faint transition-colors group-hover/tool-run:text-chat-foreground"
    >
      <span aria-hidden> · </span>
      {marks.map((mark) => mark.text).join(', ')}
    </span>
  )
}
