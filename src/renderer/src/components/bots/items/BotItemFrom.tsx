// Where an item came from, as the last line of its body: the chat (which opens it) and when.
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatMessageTimestamp } from '../../native-chat/messages/rows/NativeChatMessageTimestamp'

/** The body's last line: the chat it came from, which opens it, and when. */
export function BotItemFrom({
  chat,
  createdAt,
  onOpen
}: {
  chat: string
  createdAt: number
  onOpen: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [before, after = ''] = t('bots.items.view.fromChat', 'From {{chat}}', {
    chat: CHAT_MARK
  }).split(CHAT_MARK)
  return (
    <p className="flex min-w-0 items-baseline gap-1 text-xs text-muted-foreground">
      <span className="flex min-w-0 items-baseline whitespace-pre">
        {before}
        <button
          type="button"
          title={chat}
          className="min-w-0 truncate rounded-sm underline decoration-muted-foreground/40 underline-offset-[3px] outline-none hover:text-foreground hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={onOpen}
        >
          {chat}
        </button>
        {after}
      </span>
      {Number.isNaN(new Date(createdAt).getTime()) ? null : (
        <>
          <span aria-hidden>·</span>
          <NativeChatMessageTimestamp
            timestamp={createdAt}
            className="shrink-0 text-muted-foreground"
          />
        </>
      )}
    </p>
  )
}

const CHAT_MARK = '\u0000'
