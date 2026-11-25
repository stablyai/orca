import { Reply } from 'lucide-react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { nativeChatReplyQuoteOf } from './native-chat-reply-quote'

export type NativeChatReplyQuote = NonNullable<ReturnType<typeof nativeChatReplyQuoteOf>>

function repliedToLabel(quote: NativeChatReplyQuote, t: Translate): string {
  return quote.author === 'agent'
    ? t('components.native-chat.reply.repliedTo', 'Replied to {{name}}', {
        name: quote.label ?? ''
      })
    : t('components.native-chat.reply.repliedToYou', 'Replied to your message')
}

const firstLine = (text: string): string => text.split(/\r?\n/).find((line) => line.trim()) ?? ''

/** The one-line summary leaves out quoted lines, so only the full quote shows them. */
export function nativeChatReplySummaryOmits(quote: NativeChatReplyQuote): boolean {
  return quote.excerpt.split(/\r?\n/).filter((line) => line.trim()).length > 1
}

/** The quote the agent received, shown to the user as one compact, muted line beside their words. */
export function NativeChatReplyQuoteChip({
  quote,
  className,
  measureExcerpt
}: {
  quote: NativeChatReplyQuote
  className?: string
  /** Reports whether the excerpt is cut off, for a card that offers its full quote. */
  measureExcerpt?: (line: HTMLElement | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      className={cn(
        'mb-1.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground',
        className
      )}
      title={quote.excerpt}
    >
      <Reply aria-hidden className="size-3 shrink-0" />
      <span className="shrink-0">{repliedToLabel(quote, t)}</span>
      <span aria-hidden>·</span>
      <span ref={measureExcerpt} className="min-w-0 truncate">
        {firstLine(quote.excerpt)}
      </span>
    </div>
  )
}

/** The whole quote under an opened queued card, muted so the user's own words lead. */
export function NativeChatReplyQuoteFull({
  quote
}: {
  quote: NativeChatReplyQuote
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="mt-1.5 border-l-2 border-border pl-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-1">
        <Reply aria-hidden className="size-3 shrink-0" />
        <span>{repliedToLabel(quote, t)}</span>
      </div>
      <p className="mt-0.5 whitespace-pre-wrap break-words">{quote.excerpt}</p>
    </div>
  )
}
