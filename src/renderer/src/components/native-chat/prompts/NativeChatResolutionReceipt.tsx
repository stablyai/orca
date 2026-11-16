import { NativeChatQuestionText } from './NativeChatQuestionText'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatMessageTimestamp } from '../messages/rows/NativeChatMessageTimestamp'
import { NativeChatAwaitingInputRow } from './NativeChatAwaitingInputRow'
import { NativeChatUrlRequestReceipt } from './NativeChatUrlRequest'
import { urlApprovalProgress } from '../../../../../shared/agent-session/agent-session-approval-subject'
import {
  NATIVE_CHAT_RECEIPT_COPY,
  nativeChatReceiptAnswerHeading,
  nativeChatReceiptAnswers,
  nativeChatReceiptDevice,
  nativeChatReceiptSubject,
  type NativeChatResolvedPrompt
} from '../../../../../shared/native-chat/native-chat-resolution-receipt'

export function NativeChatResolutionReceipt({
  body,
  disclosureId,
  awaiting = true,
  outcome
}: {
  body: NativeChatResolvedPrompt
  /** Message this receipt stands in for; keys the question row's disclosure. */
  disclosureId?: string
  /** False once the prompting agent ends: report the pending question without implying anyone still waits. */
  awaiting?: boolean
  /** A worker's prompt in its coordinator's chat: who answered it, in place of "Resolved · Answered on <device>". */
  outcome?: { worker: string; text: string; reason?: { label: string; text: string } }
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
  const urlProgress = body.kind === 'approval' ? urlApprovalProgress(body) : null
  if (body.kind === 'approval' && urlProgress) {
    return <NativeChatUrlRequestReceipt body={body} {...urlProgress} />
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
      {outcome ? (
        <div>
          {t('components.native-chat.approval.worker', 'Worker · {{name}}', {
            name: outcome.worker
          })}
        </div>
      ) : null}
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
            <p className="line-clamp-3 whitespace-pre-wrap break-words">
              {answer.answer === ''
                ? t(
                    'components.native-chat.receipt.emptyAnswer',
                    NATIVE_CHAT_RECEIPT_COPY.emptyAnswer
                  )
                : (answer.answer ??
                  t(
                    'components.native-chat.receipt.unavailable',
                    NATIVE_CHAT_RECEIPT_COPY.unavailable
                  ))}
            </p>
          </div>
        )
      })}
      {outcome?.reason ? (
        <p className="line-clamp-3 whitespace-pre-wrap break-words">
          <span className="font-medium">{outcome.reason.label}: </span>
          {outcome.reason.text}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {outcome ? (
          <span>{outcome.text}</span>
        ) : (
          <>
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
                  : t(
                      'components.native-chat.receipt.resolver',
                      NATIVE_CHAT_RECEIPT_COPY.resolver,
                      {
                        device
                      }
                    )}
              </span>
            ) : null}
          </>
        )}
        <NativeChatMessageTimestamp timestamp={resolution.resolvedAt} />
      </div>
    </div>
  )
}
