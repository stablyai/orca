import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  NATIVE_CHAT_ASK_ROW_COPY,
  type NativeChatAskRowSubject
} from '../../../../shared/native-chat-ask-row'
import { NativeChatToolRunIcon } from './NativeChatToolIcon'

/**
 * The row a question tool call draws in place of its raw input. The agent is
 * blocked on the reader, so the row says that in plain words and names what was
 * asked, rather than printing the tool's name and a clipped JSON payload.
 *
 * Only the label breathes: the question is the part worth reading, and animating
 * it would make the one line the reader has to act on the hardest one to read.
 */
export function NativeChatAwaitingInputRow({
  subject,
  pending
}: {
  /** Null when the payload named no question; the label carries the row alone. */
  subject: NativeChatAskRowSubject | null
  /** Still waiting on an answer; a settled prompt reports what was asked. */
  pending: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const label = pending
    ? translate('components.native-chat.ask.awaiting', NATIVE_CHAT_ASK_ROW_COPY.awaiting)
    : translate('components.native-chat.ask.asked', NATIVE_CHAT_ASK_ROW_COPY.asked)
  const text =
    subject === null
      ? null
      : subject.kind === 'question'
        ? subject.text
        : translate(
            'components.native-chat.ask.questionCount',
            NATIVE_CHAT_ASK_ROW_COPY.questionCount,
            { value0: subject.count }
          )
  // A single-line row clips a long question, and a settled receipt is the only
  // place it is still shown, so the question itself unfolds in place.
  const expandable = subject?.kind === 'question'
  const content = (
    <>
      {/* One line tall, so the icon and chevron stay on the first line of a wrapped question. */}
      <span className="flex h-lh shrink-0 items-center">
        <NativeChatToolRunIcon iconName="message-square-more" className="text-muted-foreground" />
      </span>
      <span className={cn('shrink-0', pending && 'animate-pulse motion-reduce:animate-none')}>
        {label}
      </span>
      <span
        className={cn(
          'min-w-0 text-foreground/85',
          expanded ? 'whitespace-pre-wrap break-words' : 'truncate'
        )}
      >
        {text}
      </span>
      {expandable ? (
        <span className="flex h-lh shrink-0 items-center">
          <ChevronRight
            aria-hidden
            className={cn(
              'size-3.5 text-muted-foreground transition-all',
              expanded ? 'rotate-90 opacity-100' : 'opacity-0 group-hover/ask-row:opacity-100'
            )}
          />
        </span>
      ) : null}
    </>
  )
  const rowClassName =
    'flex min-h-6 w-full items-start gap-1.5 py-0.5 text-left text-sm leading-relaxed text-muted-foreground'

  return expandable ? (
    <button
      type="button"
      onClick={() => setExpanded(!expanded)}
      className={cn(
        rowClassName,
        'group/ask-row rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70'
      )}
      aria-expanded={expanded}
      data-native-chat-ask-row={pending ? 'awaiting' : 'asked'}
      aria-live={pending ? 'polite' : undefined}
    >
      {content}
    </button>
  ) : (
    <div
      className={rowClassName}
      data-native-chat-ask-row={pending ? 'awaiting' : 'asked'}
      aria-live={pending ? 'polite' : undefined}
    >
      {content}
    </div>
  )
}
