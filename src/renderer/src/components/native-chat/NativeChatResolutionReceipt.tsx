import { translate } from '@/i18n/i18n'
import { NativeChatMessageTimestamp } from './NativeChatMessageTimestamp'
import {
  nativeChatReceiptAnswers,
  type NativeChatResolvedPrompt
} from './native-chat-resolution-receipt'

export function NativeChatResolutionReceipt({
  body
}: {
  body: NativeChatResolvedPrompt
}): React.JSX.Element | null {
  if (body.resolution.state === 'pending') {
    return null
  }
  const { resolution } = body
  const title = body.kind === 'approval' ? body.title : body.question
  const answers = nativeChatReceiptAnswers(body)
  return (
    <div
      className="space-y-1 border-l border-border pl-3 text-xs text-muted-foreground"
      data-native-chat-receipt={body.kind}
    >
      <div className="font-medium">{title}</div>
      {body.kind === 'approval' && body.detail ? (
        <p className="line-clamp-3 whitespace-pre-wrap break-words">{body.detail}</p>
      ) : null}
      {answers.map((answer, index) => (
        <div key={body.kind === 'question' ? (body.questions?.[index]?.id ?? 'answer') : 'answer'}>
          {answer.question ? <p>{answer.question}</p> : null}
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
