import { RotateCcw } from 'lucide-react'
import {
  admitStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
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
  // Why: read through the drain's own rule, so Retry can never name an entry other than the one
  // the queue actually stopped on -- which is no longer always the head.
  const admission = admitStructuredAgentSessionOutboxEntry(outbox, blockedClientMessageId)
  const retryable = admission.state === 'blocked' ? admission.entry : null
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
