import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { sessionLinkOwnerRequest } from '../../../../shared/session-link-wait'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import { useTranslate } from '@/i18n/use-translate'
import { SecuritySurface } from '@/components/ui/security-surface'
import { Button } from '@/components/ui/button'
import { SessionLinkOwnerDecision } from './SessionLinkOwnerDecision'
import { sessionLinkStatus } from './session-link-presentation'
import { useSessionLink } from './use-session-link'

export function SessionLinkOwnerQuestion({
  sessionId,
  target,
  shouldFocus = false
}: {
  sessionId: string
  target: RuntimeClientTarget
  shouldFocus?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()

  const state = useSessionLink(sessionId, target, false)
  const snapshot = state.snapshot
  const request = snapshot && sessionLinkOwnerRequest(snapshot.events)
  if (
    !snapshot ||
    snapshot.link.state === 'ended' ||
    (!request && snapshot.link.state !== 'paused')
  ) {
    return null
  }
  const unresolved = snapshot.events.some(
    (event) => event.state === 'blocked' && event.retryable === false
  )
  if (request) {
    return (
      <div className="shrink-0">
        {state.error ? (
          <p role="alert" className="px-3 text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
        {state.uncertain ? (
          <Button
            variant="outline"
            size="sm"
            disabled={state.busy}
            onClick={() => void state.retry()}
          >
            {t('components.sessionLink.retry', 'Retry the unconfirmed action')}
          </Button>
        ) : null}
        {unresolved ? (
          <p className="px-3 text-sm">
            {t(
              'components.sessionLink.reviewBeforeContinue',
              'Review the unconfirmed delivery before continuing'
            )}
          </p>
        ) : null}
        <SessionLinkOwnerDecision
          key={request.id}
          request={request}
          link={snapshot.link}
          disabled={state.busy || state.uncertain || unresolved}
          atomic={state.policySupported}
          shouldFocus={shouldFocus}
          onAnswer={(ownerMessage) =>
            state.policySupported
              ? state.mutate('orchestration.linkControl', {
                  id: snapshot.link.id,
                  version: snapshot.link.version,
                  action: 'resume',
                  ownerMessage
                })
              : state.mutate('orchestration.linkSend', {
                  id: snapshot.link.id,
                  body: ownerMessage,
                  kind: 'owner-note'
                })
          }
        />
      </div>
    )
  }
  return (
    <SecuritySurface>
      <details open className="shrink-0 border-t bg-card text-card-foreground">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
          {t('components.sessionLink.paused', 'Paused')} ·{' '}
          {t('components.sessionLink.workTogether', 'Work together…')}
        </summary>
        <div className="max-h-80 space-y-2 overflow-y-auto px-3 pb-3 scrollbar-sleek">
          <p className="text-xs text-muted-foreground">{snapshot.link.story}</p>
          <p role="status" className="text-sm">
            {sessionLinkStatus(snapshot, t)}
          </p>
          <p className="text-xs text-muted-foreground">
            {snapshot.link.participants.map((p) => `${p.agent} · ${p.name}`).join(' ↔ ')}
          </p>
          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          ) : null}
          {state.uncertain ? (
            <Button
              variant="outline"
              size="sm"
              disabled={state.busy}
              onClick={() => void state.retry()}
            >
              {t('components.sessionLink.retry', 'Retry the unconfirmed action')}
            </Button>
          ) : null}
          {unresolved ? (
            <p className="text-sm">
              {t(
                'components.sessionLink.reviewBeforeContinue',
                'Review the unconfirmed delivery before continuing'
              )}
            </p>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={state.busy || state.uncertain || unresolved}
            onClick={() =>
              void state.mutate('orchestration.linkControl', {
                id: snapshot.link.id,
                version: snapshot.link.version,
                action: 'resume'
              })
            }
          >
            {t('components.sessionLink.continue', 'Continue link')}
          </Button>
        </div>
      </details>
    </SecuritySurface>
  )
}

export function sessionLinkOwnerQuestion(
  view: Pick<
    NativeChatStructuredViewProps,
    'sessionId' | 'target' | 'isVisible' | 'agent' | 'isFocusedGroup'
  >
): React.JSX.Element | null {
  return view.isVisible ? (
    <SessionLinkOwnerQuestion
      sessionId={view.sessionId}
      target={view.target}
      shouldFocus={view.isFocusedGroup}
    />
  ) : null
}
