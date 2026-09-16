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

  return (
    <div
      className="flex min-h-6 w-full items-center gap-1.5 py-0.5 text-sm leading-relaxed text-muted-foreground"
      data-native-chat-ask-row={pending ? 'awaiting' : 'asked'}
      aria-live={pending ? 'polite' : undefined}
    >
      <NativeChatToolRunIcon iconName="message-square-more" className="text-muted-foreground" />
      <span className={cn('shrink-0', pending && 'animate-pulse motion-reduce:animate-none')}>
        {label}
      </span>
      <span className="min-w-0 truncate text-foreground/85">{text}</span>
    </div>
  )
}
