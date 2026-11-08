import { useTranslate } from '@/i18n/use-translate'
import { NATIVE_CHAT_TOOL_ACTIVITY_COPY } from '../../../../../../shared/native-chat/tools/native-chat-tool-activity'

/** Count failures separately from calls interrupted by Stop. */
export function NativeChatToolRunCallCounts({
  failed,
  interrupted
}: {
  failed: number
  interrupted: number
}): React.JSX.Element | null {
  const t = useTranslate()
  const marks = [
    failed > 0
      ? {
          text: t(
            'components.native-chat.tool.failedCount',
            NATIVE_CHAT_TOOL_ACTIVITY_COPY.failedCount,
            { value0: failed }
          ),
          label: t(
            'components.native-chat.tool.failedCallsLabel',
            NATIVE_CHAT_TOOL_ACTIVITY_COPY.failedCallsLabel,
            { value0: failed }
          )
        }
      : null,
    interrupted > 0
      ? {
          text: t(
            'components.native-chat.tool.interruptedCount',
            NATIVE_CHAT_TOOL_ACTIVITY_COPY.interruptedCount,
            { value0: interrupted }
          ),
          label: t(
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
    /* Keep counts outside truncation and on the first summary line so narrow panes cannot hide outcomes. */
    <span className="flex h-[1lh] shrink-0 items-center">
      <span
        aria-label={marks.map((mark) => mark.label).join(', ')}
        className="shrink-0 font-sans text-xs tabular-nums text-chat-foreground-faint transition-colors group-hover/tool-run:text-chat-foreground"
      >
        <span aria-hidden> · </span>
        {marks.map((mark) => mark.text).join(', ')}
      </span>
    </span>
  )
}
