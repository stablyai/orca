import { RotateCcw } from 'lucide-react'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function NativeChatDeliveryRetry({
  outbox,
  blockedClientMessageId,
  retry
}: {
  outbox: readonly StructuredAgentSessionOutboxEntry[]
  blockedClientMessageId: string | null
  retry: (clientMessageId: string) => void
}): React.JSX.Element | null {
  // Why: only the head can hold the queue, so Retry must never name or resend a later entry.
  const head = outbox[0]
  const retryable =
    head && (head.state === 'unconfirmed' || head.clientMessageId === blockedClientMessageId)
      ? head
      : null
  if (!retryable) {
    return null
  }
  return (
    <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-4 py-1 text-xs text-muted-foreground">
      <span>
        {retryable.state === 'unconfirmed'
          ? translate(
              'auto.components.native.chat.NativeChatStructuredSession.1f772bb5d0',
              'Message delivery is unconfirmed.'
            )
          : translate(
              'auto.components.native.chat.NativeChatStructuredSession.93ef441197',
              'Message was not sent.'
            )}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => retry(retryable.clientMessageId)}
      >
        <RotateCcw className="size-3" />
        {translate('auto.components.native.chat.NativeChatStructuredSession.a5e7f14068', 'Retry')}
      </Button>
    </div>
  )
}
