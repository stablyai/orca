import { useCallback, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  NATIVE_CHAT_ASK_ROW_COPY,
  type NativeChatAskRowSubject
} from '../../../../shared/native-chat-ask-row'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'
import { NativeChatToolRunIcon } from './NativeChatToolIcon'

const ROW_CLASS_NAME =
  'flex min-h-6 w-full items-center gap-1.5 py-0.5 text-left text-sm leading-relaxed text-muted-foreground'

/**
 * The row a question tool call draws in place of its raw input. The agent is
 * blocked on the reader, so the row says that in plain words and names what was
 * asked, rather than printing the tool's name and a clipped JSON payload.
 *
 * Only the label breathes: the question is the part worth reading, and animating
 * it would make the one line the reader has to act on the hardest one to read.
 *
 * A question too long for the line becomes a disclosure. Once answered, this row
 * is the only place the question is still shown, so the full text opens below the
 * toggle, outside it, where it can be selected and copied like any other prose.
 */
export function NativeChatAwaitingInputRow({
  subject,
  pending,
  disclosureKey
}: {
  /** Null when the payload named no question; the label carries the row alone. */
  subject: NativeChatAskRowSubject | null
  /** Still waiting on an answer; a settled prompt reports what was asked. */
  pending: boolean
  /** Identity the opened question is remembered under while the row is unmounted. */
  disclosureKey?: string
}): React.JSX.Element {
  const { open, setOpen } = useNativeChatDisclosure(disclosureKey, false)
  // Seeded from `open`: a row remounted open was clipped when the reader opened
  // it, and dropping the toggle as it folds would drop keyboard focus with it.
  const [clipped, setClipped] = useState(open)
  const observerRef = useRef<ResizeObserver | null>(null)
  // Attached to the question only while it sits on the line; an open row keeps its verdict.
  const measureLine = useCallback((line: HTMLSpanElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!line) {
      return
    }
    const measure = (): void => setClipped(line.scrollWidth > line.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    observerRef.current = new ResizeObserver(measure)
    observerRef.current.observe(line)
  }, [])

  const question = subject?.kind === 'question' ? subject.text : null
  const toggles = question !== null && (open || clipped)
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
  const header = (
    <>
      <NativeChatToolRunIcon iconName="message-square-more" className="text-muted-foreground" />
      <span className={cn('shrink-0', pending && 'animate-pulse motion-reduce:animate-none')}>
        {label}
      </span>
      {toggles && open ? null : (
        <span
          ref={question === null ? undefined : measureLine}
          className="min-w-0 truncate text-foreground/85"
        >
          {text}
        </span>
      )}
      {toggles ? (
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-all',
            open
              ? 'rotate-90'
              : 'can-hover:opacity-0 group-hover/ask-row:opacity-100 group-focus-visible/ask-row:opacity-100'
          )}
        />
      ) : null}
    </>
  )

  return (
    <div
      data-native-chat-ask-row={pending ? 'awaiting' : 'asked'}
      aria-live={pending ? 'polite' : undefined}
    >
      {toggles ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={cn(
            ROW_CLASS_NAME,
            'group/ask-row rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70'
          )}
          aria-expanded={open}
        >
          {header}
        </button>
      ) : (
        <div className={ROW_CLASS_NAME}>{header}</div>
      )}
      {toggles && open ? (
        // Indented to the label, past the icon slot and its gap.
        <p className="whitespace-pre-wrap break-words pl-5.5 text-sm leading-relaxed text-foreground/85">
          {question}
        </p>
      ) : null}
    </div>
  )
}
