import { Reply } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import {
  startNativeChatReply,
  type NativeChatReplySource
} from '../../composer/reply/native-chat-reply-context'

/** Reply in a row's action bar: the next message from this chat's message box answers this one. */
export function NativeChatReplyAction({
  source,
  className
}: {
  source: NativeChatReplySource
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('components.native-chat.reply.action', 'Reply')
  return (
    <button
      type="button"
      data-native-chat-reply-action=""
      onClick={(event) => startNativeChatReply(event.currentTarget, source)}
      aria-label={label}
      title={label}
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-md text-chat-foreground-faint transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        // A subagent's transcript has no composer of its own to reply from.
        '[[data-native-chat-subagent-view]_&]:hidden',
        className
      )}
    >
      <Reply className="size-3.5" />
    </button>
  )
}
