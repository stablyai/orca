import { translate } from '@/i18n/i18n'
import { NativeChatMessageTimestamp } from './NativeChatMessageTimestamp'
import { NativeChatAwaitingInputRow } from './NativeChatAwaitingInputRow'
import {
  NATIVE_CHAT_RECEIPT_COPY,
  nativeChatReceiptAnswerHeading,
  nativeChatReceiptAnswers,
  nativeChatReceiptSubject,
  type NativeChatResolvedPrompt
} from '../../../../shared/native-chat-resolution-receipt'

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
            {heading ? <p>{heading}</p> : null}
            <p className="line-clamp-3 whitespace-pre-wrap break-words">
              {answer.answer === ''
                ? translate(
                    'components.native-chat.receipt.emptyAnswer',
                    NATIVE_CHAT_RECEIPT_COPY.emptyAnswer
                  )
                : (answer.answer ??
                  translate(
                    'components.native-chat.receipt.unavailable',
                    NATIVE_CHAT_RECEIPT_COPY.unavailable
                  ))}
            </p>
          </div>
        )
      })}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          {resolution.state === 'cancelled'
            ? translate(
                'components.native-chat.receipt.cancelled',
                NATIVE_CHAT_RECEIPT_COPY.cancelled
              )
            : translate(
                'components.native-chat.receipt.resolved',
                NATIVE_CHAT_RECEIPT_COPY.resolved
              )}
        </span>
        {resolution.resolvedBy ? (
          <span>
            {resolution.state === 'cancelled'
              ? translate(
                  'components.native-chat.receipt.cancelledBy',
                  NATIVE_CHAT_RECEIPT_COPY.cancelledBy,
                  { device: resolution.resolvedBy }
                )
              : translate(
                  'components.native-chat.receipt.resolver',
                  NATIVE_CHAT_RECEIPT_COPY.resolver,
                  { device: resolution.resolvedBy }
                )}
          </span>
        ) : null}
        <NativeChatMessageTimestamp timestamp={resolution.resolvedAt} />
      </div>
    </div>
  )
}
