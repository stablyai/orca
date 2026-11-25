import {
  NATIVE_CHAT_UNKERNED_CSS,
  nativeChatTextHasUnkernedRun
} from '@/components/native-chat/composer/editor/native-chat-unkerned-runs'
import {
  NativeChatReplyQuoteFull,
  type NativeChatReplyQuote
} from '../composer/reply/NativeChatReplyQuoteChip'

/** An opened queued card: the user's words first, then a reply's whole quote, muted. */
export function QueuedMessageFullText({
  id,
  text,
  quote
}: {
  id: string
  text: string
  quote: NativeChatReplyQuote | null
}): React.JSX.Element {
  return (
    <div id={id} className="scrollbar-sleek mt-1 max-h-60 overflow-y-auto pl-5.5">
      {text ? (
        <p
          className="whitespace-pre-wrap break-words text-sm text-foreground"
          style={nativeChatTextHasUnkernedRun(text) ? NATIVE_CHAT_UNKERNED_CSS : undefined}
        >
          {text}
        </p>
      ) : null}
      {quote ? <NativeChatReplyQuoteFull quote={quote} /> : null}
    </div>
  )
}
