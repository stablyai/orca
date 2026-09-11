// The strip between the transcript and the composer: every reason this pane is not fully live.
//
// Kept out of the pane so each notice is one place and the pane stays a layout: the pane's job is
// the transcript, the prompt cards and the composer, not the wording of every degraded state.

import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { StructuredAgentSessionController } from './use-structured-agent-session'

function NoticeRow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-4 py-1 text-xs text-muted-foreground">
      {children}
    </div>
  )
}

function RetryButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <Button type="button" variant="ghost" size="xs" onClick={onClick}>
      <RotateCcw className="size-3" />
      {translate('auto.components.native.chat.NativeChatStructuredSession.a5e7f14068', 'Retry')}
    </Button>
  )
}

export function NativeChatStructuredSessionNotices({
  controller,
  composerError
}: {
  controller: StructuredAgentSessionController
  composerError: string | null
}): React.JSX.Element {
  // Only the head of the outbox is ever dispatched, so it is the only entry a
  // Retry can act on and the only one whose state can be holding the queue.
  // Scanning past it named a message the user was not looking at and re-sent
  // one from earlier in the session while their newest sat behind it.
  const outboxHead = controller.outbox[0] ?? null
  const retryableOutboxEntry =
    outboxHead &&
    (outboxHead.state === 'unconfirmed' ||
      outboxHead.clientMessageId === controller.blockedClientMessageId)
      ? outboxHead
      : null
  return (
    <>
      {retryableOutboxEntry ? (
        <NoticeRow>
          <span>
            {retryableOutboxEntry.state === 'unconfirmed'
              ? translate(
                  'auto.components.native.chat.NativeChatStructuredSession.1f772bb5d0',
                  'Message delivery is unconfirmed.'
                )
              : translate(
                  'auto.components.native.chat.NativeChatStructuredSession.93ef441197',
                  'Message was not sent.'
                )}
          </span>
          <RetryButton onClick={() => controller.retry(retryableOutboxEntry.clientMessageId)} />
        </NoticeRow>
      ) : null}
      {controller.cached ? (
        <p className="mx-auto w-full max-w-4xl px-4 py-1 text-xs text-muted-foreground">
          {translate(
            'components.native-chat.structuredSessionOwnerRepaired',
            'This chat\u2019s host was re-paired. Showing the last loaded transcript; sending is off.'
          )}
        </p>
      ) : null}
      {controller.error || composerError ? (
        <p className="mx-auto w-full max-w-4xl px-4 py-1 text-xs text-destructive">
          {controller.error ?? composerError}
        </p>
      ) : null}
    </>
  )
}
