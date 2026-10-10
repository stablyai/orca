import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  NATIVE_CHAT_ASK_ROW_COPY,
  type NativeChatAskRowSubject
} from '../../../../shared/native-chat-ask-row'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'
import { NativeChatToolRunIcon } from './NativeChatToolIcon'
import { useNativeChatClippedLine } from './use-native-chat-clipped-line'

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
 * A question too long for the line becomes a disclosure, and so does a grouped
 * prompt, whose line names only a count. Once answered, this row may be the only
 * place the questions are still shown, so the full text opens below the toggle,
 * outside it, where it can be selected and copied like any other prose.
 */
export function NativeChatAwaitingInputRow({
  subject,
  pending,
  disclosureKey,
  listsQuestions = true
}: {
  /** Null when the payload named no question; the label carries the row alone. */
  subject: NativeChatAskRowSubject | null
  /** Still waiting on an answer; a settled prompt reports what was asked. */
  pending: boolean
  /** Identity the opened question is remembered under while the row is unmounted. */
  disclosureKey?: string
  /** False when the caller already shows each question of a grouped prompt in full. */
  listsQuestions?: boolean
}): React.JSX.Element {
  // The list and a lone question are separate disclosures: a pending Codex group is
  // keyed by its first question, which becomes its own row once answered.
  const { open, setOpen } = useNativeChatDisclosure(
    disclosureKey !== undefined && subject?.kind === 'questions'
      ? `${disclosureKey}:questions`
      : disclosureKey,
    false
  )
  // Seeded from `open`: a row remounted open was clipped when the reader opened
  // it, and dropping the toggle as it folds would drop keyboard focus with it.
  const [clipped, measureLine] = useNativeChatClippedLine(open)

  const question = subject?.kind === 'question' ? subject.text : null
  const questions = subject?.kind === 'questions' && listsQuestions ? subject.questions : null
  // A count always hides its questions, so the list needs no clipping measurement.
  const toggles = questions !== null || (question !== null && (open || clipped))
  // With nothing to name, the label must read as a whole phrase, not end on a colon.
  const label = !pending
    ? translate('components.native-chat.ask.asked', NATIVE_CHAT_ASK_ROW_COPY.asked)
    : subject === null
      ? translate(
          'components.native-chat.ask.awaitingUnnamed',
          NATIVE_CHAT_ASK_ROW_COPY.awaitingUnnamed
        )
      : translate('components.native-chat.ask.awaiting', NATIVE_CHAT_ASK_ROW_COPY.awaiting)
  const text =
    subject === null
      ? null
      : subject.kind === 'question'
        ? subject.text
        : translate(
            'components.native-chat.ask.questionCount',
            NATIVE_CHAT_ASK_ROW_COPY.questionCount,
            { value0: subject.questions.length }
          )
  const header = (
    <>
      <NativeChatToolRunIcon iconName="message-square-more" className="text-muted-foreground" />
      <span className={cn('shrink-0', pending && 'animate-pulse motion-reduce:animate-none')}>
        {label}
      </span>
      {question !== null && toggles && open ? null : (
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
            'size-3.5 shrink-0 text-muted-foreground transition-all motion-reduce:transition-none',
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
      {toggles && open && question !== null ? (
        // Indented to the label, past the icon slot and its gap.
        <p className="whitespace-pre-wrap break-words pl-5.5 text-sm leading-relaxed text-foreground/85">
          {question}
        </p>
      ) : null}
      {open && questions !== null ? (
        // Numbers hang in the icon slot so each question starts under the label.
        <ol className="list-decimal space-y-1 pl-5.5 text-sm leading-relaxed text-foreground/85 marker:text-muted-foreground">
          {questions.map((entry) => (
            <li key={entry} className="whitespace-pre-wrap break-words">
              {entry}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}
