import { Reply } from 'lucide-react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { nativeChatReplyQuoteOf } from './native-chat-reply-quote'

type ReplyQuote = NonNullable<ReturnType<typeof nativeChatReplyQuoteOf>>

function repliedToLabel(quote: ReplyQuote, t: Translate): string {
  return quote.author === 'agent'
    ? t('components.native-chat.reply.repliedTo', 'Replied to {{name}}', {
        name: quote.label ?? ''
      })
    : t('components.native-chat.reply.repliedToYou', 'Replied to your message')
}

const firstLine = (text: string): string => text.split(/\r?\n/).find((line) => line.trim()) ?? ''

/** A sent reply's quote for places that show plain text such as a queued card: one line, or with
 *  `full` the whole excerpt on its own lines. */
export function nativeChatReplyDisplayText(text: string, t: Translate, full = false): string {
  const quote = nativeChatReplyQuoteOf(text)
  if (!quote) {
    return text
  }
  const head = full
    ? `↩ ${repliedToLabel(quote, t)}\n${quote.excerpt}\n`
    : `↩ ${repliedToLabel(quote, t)} · ${firstLine(quote.excerpt)}`
  return quote.rest.trim() ? `${head}\n${quote.rest}` : head.trimEnd()
}

/** The one-line summary leaves out quoted lines, so only the full text shows them. */
export function nativeChatReplySummaryOmits(text: string): boolean {
  const lines = nativeChatReplyQuoteOf(text)?.excerpt.split(/\r?\n/) ?? []
  return lines.filter((line) => line.trim()).length > 1
}

/** The quote the agent received, shown to the user as one compact line above their words. */
export function NativeChatReplyQuoteChip({ quote }: { quote: ReplyQuote }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      className="mb-1.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
      title={quote.excerpt}
    >
      <Reply aria-hidden className="size-3 shrink-0" />
      <span className="shrink-0">{repliedToLabel(quote, t)}</span>
      <span aria-hidden>·</span>
      <span className="min-w-0 truncate">{firstLine(quote.excerpt)}</span>
    </div>
  )
}
