import { SessionLinkDeliveryReview } from './SessionLinkDeliveryReview'
import { useEffect, useRef } from 'react'
import type { SessionLinkSnapshot } from '../../../../shared/session-link'
import { useTranslate, useIntlLocale } from '@/i18n/use-translate'
import {
  sessionLinkDeliveryState,
  sessionLinkEventKind,
  sessionLinkReason
} from './session-link-presentation'

export function SessionLinkJournal({
  snapshot,
  disabled = false,
  onResolve
}: {
  disabled?: boolean
  onResolve?: (eventId: string) => void
  snapshot: SessionLinkSnapshot
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()

  const element = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  useEffect(() => {
    if (following.current && element.current) {
      element.current.scrollTop = element.current.scrollHeight
    }
  }, [snapshot.events.length])
  const name = (actor: string) =>
    actor === 'owner'
      ? t('components.sessionLink.you', 'You')
      : actor === 'host'
        ? 'Orca'
        : (snapshot.link.participants.find((p) => p.sessionId === actor)?.name ?? actor)
  return (
    <div
      ref={element}
      className="max-h-80 space-y-3 overflow-y-auto scrollbar-sleek"
      aria-label={t('components.sessionLink.journal', 'Link journal')}
      onScroll={(e) => {
        const list = e.currentTarget
        following.current = list.scrollHeight - list.scrollTop - list.clientHeight < 64
      }}
    >
      {snapshot.events.map((event) => (
        <article key={event.id} className="space-y-1 border-l pl-3">
          <p className="text-xs text-muted-foreground">
            {new Date(event.createdAt).toLocaleTimeString(intlLocale)} · {name(event.actor)}
            {event.recipient ? ` → ${name(event.recipient)}` : ''} ·{' '}
            {sessionLinkEventKind(event.kind, t)}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm">
            {event.participantSessionIds
              ? `${sessionLinkReason(event.detail, t)}: ${event.participantSessionIds.map(name).join(', ')}`
              : event.body || sessionLinkReason(event.detail, t)}
            {event.policy
              ? ` · ${event.policy.turnLimit === null ? t('components.sessionLink.untilAccepted', 'Until the reviewer accepts the result') : event.policy.turnLimit}`
              : null}
          </p>
          {event.recipient && event.kind !== 'control' ? (
            <p className="text-xs text-muted-foreground">
              {sessionLinkDeliveryState(event.state, t)}
            </p>
          ) : null}
          {onResolve &&
          snapshot.link.state === 'paused' &&
          event.state === 'blocked' &&
          event.retryable === false ? (
            <SessionLinkDeliveryReview disabled={disabled} onResolve={() => onResolve(event.id)} />
          ) : null}
          {event.body && event.detail ? (
            <details className="text-xs text-muted-foreground">
              <summary>{t('components.sessionLink.details', 'Delivery details')}</summary>
              <p className="break-words">{sessionLinkReason(event.detail, t)}</p>
            </details>
          ) : null}
        </article>
      ))}
    </div>
  )
}
