import { useState } from 'react'
import { Link2 } from 'lucide-react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { SessionLinkCreate } from './SessionLinkCreate'
import { SessionLinkJournal } from './SessionLinkJournal'
import { sessionLinkStatus } from './session-link-presentation'
import { sessionLinkWaitingFor } from '../../../../shared/session-link-wait'
import { useSessionLink } from './use-session-link'

export function SessionLinkControl({
  sessionId,
  target,
  initialPartnerSessionId,
  sourceName,
  partnerName,
  dialogOnly = false,
  onDismiss
}: {
  sessionId: string
  target: RuntimeClientTarget
  initialPartnerSessionId?: string
  sourceName?: string
  partnerName?: string
  dialogOnly?: boolean
  onDismiss?: () => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(dialogOnly)
  const [body, setBody] = useState('')
  const state = useSessionLink(sessionId, target, open)
  if (!state.supported) {
    return null
  }
  const snapshot = state.snapshot
  const link = snapshot?.link
  const partner = link?.participants.find((p) => p.sessionId !== sessionId)
  const waiting =
    link?.state === 'active' &&
    snapshot &&
    link.participants.some((p) => sessionLinkWaitingFor(snapshot.events, p.sessionId))
  const unresolvedDelivery =
    snapshot?.events.some((event) => event.state === 'blocked' && event.retryable === false) ??
    false
  const status =
    link?.state === 'paused'
      ? t('components.sessionLink.paused', 'Paused')
      : link?.state === 'ended'
        ? t('components.sessionLink.endedShort', 'Ended')
        : waiting
          ? t('components.sessionLink.waitingShort', 'Waiting')
          : null
  const control = (action: 'pause' | 'resume' | 'stop' | 'end') => {
    if (link) {
      void state.mutate('orchestration.linkControl', { id: link.id, action, version: link.version })
    }
  }
  return (
    <>
      {!dialogOnly ? (
        <Button
          variant="ghost"
          size="xs"
          className="min-w-0 max-w-64"
          onClick={() => setOpen(true)}
        >
          <Link2 className="size-3" />
          <span className="truncate">
            {link
              ? `${t('components.sessionLink.linked', 'Linked with')} ${partner?.name ?? partner?.agent ?? ''}`
              : t('components.sessionLink.workTogether', 'Work together…')}
          </span>
          {status ? <span className="shrink-0">· {status}</span> : null}
        </Button>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value)
          if (!value) {
            onDismiss?.()
          }
        }}
      >
        <DialogContent surface="security" scrollable className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('components.sessionLink.workTogether', 'Work together…')}</DialogTitle>
            <DialogDescription>
              {t(
                'components.sessionLink.description',
                'Connect two existing local chats. You control the story, permissions and continuation.'
              )}
            </DialogDescription>
          </DialogHeader>
          {state.error ? (
            <p role="alert" className="break-words text-sm text-destructive">
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
          {snapshot &&
          initialPartnerSessionId &&
          !snapshot.link.participants.some((p) => p.sessionId === initialPartnerSessionId) ? (
            <p role="alert" className="text-sm">
              {t(
                'components.sessionLink.otherLink',
                'This chat is already linked to another partner. End that link before connecting these two chats.'
              )}
            </p>
          ) : null}
          {snapshot ? (
            <div className="space-y-4">
              <p className="whitespace-pre-wrap break-words text-sm font-medium">
                {snapshot.link.story}
              </p>
              <p className="text-xs text-muted-foreground">
                {snapshot.link.participants.map((p) => `${p.agent} · ${p.name}`).join(' ↔ ')}
              </p>
              <p role="status" className="text-sm">
                {sessionLinkStatus(snapshot)}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    state.busy ||
                    state.uncertain ||
                    link?.state === 'ended' ||
                    (link?.state === 'paused' && unresolvedDelivery)
                  }
                  title={
                    link?.state === 'paused' && unresolvedDelivery
                      ? t(
                          'components.sessionLink.reviewBeforeContinue',
                          'Review the unconfirmed delivery before continuing'
                        )
                      : undefined
                  }
                  onClick={() => control(link?.state === 'paused' ? 'resume' : 'pause')}
                >
                  {link?.state === 'paused'
                    ? t('components.sessionLink.resume', 'Continue for 6 more turns')
                    : t('components.sessionLink.pause', 'Pause')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={state.busy || state.uncertain || link?.state === 'ended'}
                  onClick={() => control('stop')}
                >
                  {t('components.sessionLink.stop', 'Stop link turns')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={state.busy || state.uncertain || link?.state === 'ended'}
                  onClick={() => control('end')}
                >
                  {t('components.sessionLink.end', 'End link')}
                </Button>
              </div>
              <SessionLinkJournal
                snapshot={snapshot}
                disabled={state.busy || state.uncertain}
                onResolve={(eventId) => {
                  void state.mutate('orchestration.linkResolve', {
                    id: snapshot.link.id,
                    version: snapshot.link.version,
                    eventId
                  })
                }}
              />
              <p className="text-xs text-muted-foreground">
                {snapshot.link.turns} / 6 {t('components.sessionLink.turns', 'automatic turns')} ·{' '}
                {snapshot.link.messages} / 12{' '}
                {t('components.sessionLink.messages', 'agent messages')}
              </p>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={state.busy || state.uncertain || link?.state === 'ended'}
                maxLength={8192}
                aria-label={t('components.sessionLink.ownerMessage', 'Your message to both agents')}
                placeholder={t(
                  'components.sessionLink.ownerMessage',
                  'Your message to both agents'
                )}
              />
              <Button
                disabled={state.busy || state.uncertain || !body.trim() || link?.state === 'ended'}
                onClick={() => {
                  if (link) {
                    void state
                      .mutate('orchestration.linkSend', { id: link.id, body, kind: 'owner-note' })
                      .then((ok) => {
                        if (ok) {
                          setBody('')
                        }
                      })
                  }
                }}
              >
                {t('components.sessionLink.sendBoth', 'Send to both')}
              </Button>
            </div>
          ) : state.candidates ? (
            <>
              <SessionLinkCreate
                source={{
                  ...state.candidates.source,
                  name: sourceName ?? state.candidates.source.name
                }}
                initialPartnerSessionId={initialPartnerSessionId}
                candidates={state.candidates.candidates.map((candidate) =>
                  candidate.sessionId === initialPartnerSessionId && partnerName
                    ? { ...candidate, name: partnerName }
                    : candidate
                )}
                busy={state.busy || state.uncertain}
                onCreate={(partnerSessionId, story, role) =>
                  void state.mutate('orchestration.linkCreate', {
                    sessionId,
                    partnerSessionId,
                    story,
                    role
                  })
                }
              />
              {state.candidates.history.length ? (
                <div className="space-y-2 border-t pt-3">
                  <p className="text-xs text-muted-foreground">
                    {t('components.sessionLink.history', 'Previous links')}
                  </p>
                  {state.candidates.history.map((previous) => (
                    <Button
                      key={previous.id}
                      variant="ghost"
                      className="h-auto max-w-full whitespace-normal text-left"
                      onClick={() => void state.show(previous.id)}
                    >
                      {previous.story}
                    </Button>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('components.sessionLink.loading', 'Loading available sessions…')}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
