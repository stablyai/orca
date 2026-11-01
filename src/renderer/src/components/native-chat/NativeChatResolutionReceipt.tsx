import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { agentSessionFormBooleanLabels } from '../../../../shared/agent-session-form-copy'
import { useNativeChatSettledBody } from './native-chat-settled-body'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { translate } from '@/i18n/i18n'
import { NativeChatMessageTimestamp } from './NativeChatMessageTimestamp'
import { NativeChatAwaitingInputRow } from './NativeChatAwaitingInputRow'
import {
  NATIVE_CHAT_RECEIPT_COPY,
  nativeChatReceiptAnswerHeading,
  nativeChatReceiptAnswerEntries,
  nativeChatReceiptSubject,
  type NativeChatResolvedPrompt
} from '../../../../shared/native-chat-resolution-receipt'

export function NativeChatResolutionReceipt({
  body: presentation,
  disclosureId,
  awaiting = true
}: {
  body: NativeChatResolvedPrompt
  /** Message this receipt stands in for; keys the question row's disclosure. */
  disclosureId?: string
  /** False once the prompting agent ends: report the pending question without implying anyone still waits. */
  awaiting?: boolean
}): React.JSX.Element | null {
  useUiLanguageRevision()
  const hydrated = useNativeChatSettledBody(presentation)
  const body: NativeChatResolvedPrompt =
    presentation.deferredBody && hydrated.status === 'ready' ? hydrated.body : presentation
  const incomplete = !!body.deferredBody
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
  const answers = incomplete
    ? []
    : nativeChatReceiptAnswerEntries(body, agentSessionFormBooleanLabels(translate))
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
      {incomplete ? (
        hydrated.status === 'loading' ? (
          <LoadingSpinner className="size-3" />
        ) : (
          <p>
            {translate(
              'components.native-chat.receipt.unavailable',
              NATIVE_CHAT_RECEIPT_COPY.unavailable
            )}
          </p>
        )
      ) : null}
      {answers.map(({ key, answer }) => {
        const heading = nativeChatReceiptAnswerHeading(subject, answer)
        return (
          <div key={key}>
            {heading ? <p>{heading}</p> : null}
            <p
              className={
                body.kind === 'approval' && body.form
                  ? 'whitespace-pre-wrap break-words'
                  : 'line-clamp-3 whitespace-pre-wrap break-words'
              }
            >
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
