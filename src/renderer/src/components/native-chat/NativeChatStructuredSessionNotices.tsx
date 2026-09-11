// The strip between the transcript and the composer: every reason this pane is not fully live.
//
// Kept out of the pane so each notice is one place and the pane stays a layout: the pane's job is
// the transcript, the prompt cards and the composer, not the wording of every degraded state.

import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { StructuredAgentSessionController } from './use-structured-agent-session'
import type { StructuredAgentSessionHoldState } from './structured-agent-session-hold-outcome'

// The only honest sentence about a structured session's lifetime: holds are connection-scoped and
// the host's release grace is 15 seconds, so nothing runs on while the pane is away.
function holdLifetimeNote(): string {
  return translate(
    'components.native-chat.structuredSessionHoldLifetime',
    'The in-flight turn and its approvals survive going offline; idle sessions park after about 15 seconds and resume on demand.'
  )
}

function holdRefusalNote(code: string): string {
  if (code === 'execution_owner_reconciling') {
    return translate(
      'components.native-chat.structuredSessionHoldReconciling',
      'Orca is still working out who owns this session on its host, so it is not reserved yet.'
    )
  }
  if (code === 'agent_session_conflict') {
    return translate(
      'components.native-chat.structuredSessionHoldConflict',
      'Another surface already holds this session on its host, so this pane did not reserve it.'
    )
  }
  if (code === 'agent_session_ownership_unknown') {
    return translate(
      'components.native-chat.structuredSessionHoldOwnerUnknown',
      'This session\u2019s host could not prove who owns it, so this pane did not reserve it.'
    )
  }
  return translate(
    'components.native-chat.structuredSessionHoldFailed',
    'This session could not be reserved on its host.'
  )
}

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

/** A live host this client only reads. Deliberately not one of the hold states below: nothing was
 *  refused and nothing is missing on the other machine, so saying "update that server" would send
 *  the user after the wrong fix. The reason is here, in a setting the user owns. */
function RemoteReadOnlyNotice(): React.JSX.Element {
  return (
    <NoticeRow>
      <span data-native-chat-remote="read-only">
        {translate(
          'components.native-chat.structuredSessionRemoteReadOnly',
          'This chat runs on a paired host. Sending to chats on paired hosts is off in your settings, so it is shown here read-only.'
        )}{' '}
        {holdLifetimeNote()}
      </span>
    </NoticeRow>
  )
}

/** The two degraded states stay apart: a host that answers and lacks the method is an update
 *  prompt, never an error; a host that never answered is the read-only one. */
function HoldNotice({
  hold,
  onRetry
}: {
  hold: StructuredAgentSessionHoldState
  onRetry: () => void
}): React.JSX.Element | null {
  if (hold.kind === 'unsupported') {
    return (
      <NoticeRow>
        <span data-native-chat-hold="unsupported">
          {translate(
            'components.native-chat.structuredSessionHoldUnsupported',
            'This chat\u2019s host runs an older Orca server that cannot reserve this session. Update that server to keep it reserved.'
          )}{' '}
          {holdLifetimeNote()}
        </span>
      </NoticeRow>
    )
  }
  if (hold.kind === 'unreachable') {
    return (
      <NoticeRow>
        <span data-native-chat-hold="unreachable">
          {translate(
            'components.native-chat.structuredSessionHoldUnreachable',
            'This chat\u2019s host has not answered, so this session is not reserved. Showing the last loaded transcript; sending is off.'
          )}{' '}
          {holdLifetimeNote()}
        </span>
        <RetryButton onClick={onRetry} />
      </NoticeRow>
    )
  }
  if (hold.kind === 'refused') {
    return (
      <NoticeRow>
        <span data-native-chat-hold="refused">{holdRefusalNote(hold.code)}</span>
        <RetryButton onClick={onRetry} />
      </NoticeRow>
    )
  }
  return null
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
      {controller.remoteReadOnly ? (
        <RemoteReadOnlyNotice />
      ) : (
        <HoldNotice hold={controller.hold} onRetry={controller.retryHold} />
      )}
      {controller.error || composerError ? (
        <p className="mx-auto w-full max-w-4xl px-4 py-1 text-xs text-destructive">
          {controller.error ?? composerError}
        </p>
      ) : null}
    </>
  )
}
