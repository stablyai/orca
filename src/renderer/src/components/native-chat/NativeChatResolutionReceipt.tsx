import { translate } from '@/i18n/i18n'
import { NativeChatMessageTimestamp } from './NativeChatMessageTimestamp'
import { NativeChatAwaitingInputRow } from './NativeChatAwaitingInputRow'
import type { NativeChatAskRowSubject } from '../../../../shared/native-chat-ask-row'
import {
  nativeChatReceiptAnswers,
  type NativeChatResolvedPrompt
} from './native-chat-resolution-receipt'

export function NativeChatResolutionReceipt({
  body,
  disclosureId
}: {
  body: NativeChatResolvedPrompt
  /** Message this receipt stands in for; keys the question row's disclosure. */
  disclosureId?: string
}): React.JSX.Element | null {
  const askDisclosureKey = disclosureId === undefined ? undefined : `ask:${disclosureId}`
  const subject: NativeChatAskRowSubject | null =
    body.kind !== 'question'
      ? null
      : body.questions && body.questions.length > 1
        ? { kind: 'count', count: body.questions.length }
        : {
            kind: 'question',
            // Claude keeps a generic grouped label for a single multi-select
            // question. Use it after resolution so the answer's question line
            // is not repeated in the heading.
            text:
              body.resolution.state !== 'pending' &&
              body.questions?.length === 1 &&
              body.questions[0]?.question !== body.question
                ? body.question
                : (body.questions?.[0]?.question ?? body.question)
          }
  if (body.resolution.state === 'pending') {
    return body.kind === 'question' ? (
      <NativeChatAwaitingInputRow subject={subject} pending disclosureKey={askDisclosureKey} />
    ) : null
  }
  const { resolution } = body
  const title = body.kind === 'approval' ? (body.displayName ?? body.title) : body.question
  const answers = nativeChatReceiptAnswers(body)
  return (
    <div
      className="space-y-1 border-l border-border pl-3 text-xs text-muted-foreground"
      data-native-chat-receipt={body.kind}
    >
      {body.kind === 'question' ? (
        <NativeChatAwaitingInputRow
          pending={false}
          subject={subject}
          disclosureKey={askDisclosureKey}
        />
      ) : (
        <div className="font-medium">{title}</div>
      )}
      {body.kind === 'approval' && body.detail ? (
        <p className="line-clamp-3 whitespace-pre-wrap break-words">{body.detail}</p>
      ) : null}
      {answers.map((answer, index) => (
        <div key={body.kind === 'question' ? (body.questions?.[index]?.id ?? 'answer') : 'answer'}>
          {answer.question &&
          !(
            body.kind === 'question' &&
            body.questions?.length === 1 &&
            subject?.kind === 'question' &&
            answer.question === subject.text
          ) ? (
            <p>{answer.question}</p>
          ) : null}
          <p className="line-clamp-3 whitespace-pre-wrap break-words">
            {answer.answer ??
              translate(
                'components.native-chat.receipt.unavailable',
                'Selected answer unavailable'
              )}
          </p>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          {resolution.state === 'cancelled'
            ? translate('components.native-chat.receipt.cancelled', 'Cancelled')
            : translate('components.native-chat.receipt.resolved', 'Resolved')}
        </span>
        {resolution.resolvedBy ? (
          <span>
            {resolution.state === 'cancelled'
              ? translate('components.native-chat.receipt.cancelledBy', 'Cancelled on {{device}}', {
                  device: resolution.resolvedBy
                })
              : translate('components.native-chat.receipt.resolver', 'Answered on {{device}}', {
                  device: resolution.resolvedBy
                })}
          </span>
        ) : null}
        <NativeChatMessageTimestamp timestamp={resolution.resolvedAt} />
      </div>
    </div>
  )
}
