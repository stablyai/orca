import { Check, ChevronRight } from 'lucide-react'
import { NativeChatQuestionText } from './NativeChatQuestionText'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatMessageTimestamp } from '../messages/rows/NativeChatMessageTimestamp'
import { NativeChatAwaitingInputRow } from './NativeChatAwaitingInputRow'
import { useNativeChatDisclosure } from '../messages/disclosure/native-chat-disclosure-store'
import {
  NATIVE_CHAT_RECEIPT_COPY,
  nativeChatReceiptAnswerHeading,
  nativeChatReceiptAnswers,
  nativeChatReceiptDevice,
  nativeChatReceiptSubject,
  type NativeChatReceiptAnswer,
  type NativeChatResolvedPrompt
} from '../../../../../shared/native-chat/native-chat-resolution-receipt'

/** The answer opens onto every option that was offered, so long option lists stay readable after resolution. */
function NativeChatReceiptAnswerRow({
  answer,
  disclosureKey
}: {
  answer: NativeChatReceiptAnswer
  disclosureKey?: string
}): React.JSX.Element {
  const t = useTranslate()
  const { open, setOpen } = useNativeChatDisclosure(disclosureKey, false)
  const text =
    answer.answer === ''
      ? t('components.native-chat.receipt.emptyAnswer', NATIVE_CHAT_RECEIPT_COPY.emptyAnswer)
      : (answer.answer ??
        t('components.native-chat.receipt.unavailable', NATIVE_CHAT_RECEIPT_COPY.unavailable))
  if (answer.options.length === 0) {
    return <p className="line-clamp-3 whitespace-pre-wrap break-words">{text}</p>
  }
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group/receipt-answer flex w-full items-start gap-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="line-clamp-3 min-w-0 whitespace-pre-wrap break-words">{text}</span>
        <ChevronRight
          aria-hidden
          className={cn(
            'mt-0.5 size-3 shrink-0 transition-all motion-reduce:transition-none',
            open
              ? 'rotate-90'
              : 'can-hover:opacity-0 group-hover/receipt-answer:opacity-100 group-focus-visible/receipt-answer:opacity-100'
          )}
        />
      </button>
      {open ? (
        <ul className="space-y-0.5 py-0.5">
          {answer.options.map((option, index) => (
            <li key={index} className="flex items-start gap-1.5">
              <Check
                aria-hidden
                className={cn('mt-0.5 size-3 shrink-0', !option.selected && 'invisible')}
              />
              <div className="min-w-0 break-words">
                <span className={cn(option.selected && 'font-medium text-chat-foreground')}>
                  {option.label}
                </span>
                {option.description ? (
                  <p className="whitespace-pre-wrap">{option.description}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}

export function NativeChatResolutionReceipt({
  body,
  disclosureId,
  awaiting = true
}: {
  body: NativeChatResolvedPrompt
  /** Message this receipt stands in for; keys the question row's disclosure. */
  disclosureId?: string
  /** False once the prompting agent ends: report the pending question without implying anyone still waits. */
  awaiting?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const askDisclosureKey = disclosureId === undefined ? undefined : `ask:${disclosureId}`
  const subject = nativeChatReceiptSubject(body)
  if (body.resolution.state === 'pending') {
    return body.kind === 'question' ? (
      <NativeChatAwaitingInputRow
        subject={subject}
        pending={awaiting}
        disclosureKey={askDisclosureKey}
      />
    ) : null
  }
  const { resolution } = body
  const device = nativeChatReceiptDevice(resolution, {
    current: t('components.native-chat.receipt.thisComputer', 'this computer'),
    computer: t('components.native-chat.receipt.computer', 'the computer'),
    unknown: t('components.native-chat.receipt.otherDevice', 'another device')
  })
  const title = body.kind === 'approval' ? (body.displayName ?? body.title) : body.question
  // Non-empty only once resolved, and then each question is listed with its answer.
  const answers = nativeChatReceiptAnswers(body)
  return (
    <div
      className="space-y-1 border-l border-border pl-3 text-xs text-chat-foreground-faint"
      data-native-chat-receipt={body.kind}
    >
      {body.kind === 'question' ? (
        <NativeChatAwaitingInputRow
          pending={false}
          subject={subject}
          disclosureKey={askDisclosureKey}
          listsQuestions={answers.length === 0}
        />
      ) : (
        <div className="font-medium">{title}</div>
      )}
      {body.kind === 'approval' && body.detail ? (
        <p className="line-clamp-3 whitespace-pre-wrap break-words">{body.detail}</p>
      ) : null}
      {answers.map((answer, index) => {
        const heading = nativeChatReceiptAnswerHeading(subject, answer)
        return (
          <div
            key={body.kind === 'question' ? (body.questions?.[index]?.id ?? 'answer') : 'answer'}
          >
            {heading ? <NativeChatQuestionText content={heading} /> : null}
            <NativeChatReceiptAnswerRow
              answer={answer}
              disclosureKey={
                askDisclosureKey === undefined ? undefined : `${askDisclosureKey}:options:${index}`
              }
            />
          </div>
        )
      })}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          {resolution.state === 'cancelled'
            ? t('components.native-chat.receipt.cancelled', NATIVE_CHAT_RECEIPT_COPY.cancelled)
            : t('components.native-chat.receipt.resolved', NATIVE_CHAT_RECEIPT_COPY.resolved)}
        </span>
        {resolution.resolvedBy ? (
          <span>
            {resolution.state === 'cancelled'
              ? t(
                  'components.native-chat.receipt.cancelledBy',
                  NATIVE_CHAT_RECEIPT_COPY.cancelledBy,
                  { device }
                )
              : t('components.native-chat.receipt.resolver', NATIVE_CHAT_RECEIPT_COPY.resolver, {
                  device
                })}
          </span>
        ) : null}
        <NativeChatMessageTimestamp timestamp={resolution.resolvedAt} />
      </div>
    </div>
  )
}
