import { useState } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { SessionLinkAddParticipants } from './SessionLinkAddParticipants'
import { SessionLinkCreate } from './SessionLinkCreate'
import { SessionLinkJournal } from './SessionLinkJournal'
import { sessionLinkStatus } from './session-link-presentation'
import { SessionLinkOwnerDecision } from './SessionLinkOwnerDecision'
import { SessionLinkPolicySettings } from './SessionLinkPolicySettings'
import { SessionLinkTrigger } from './SessionLinkTrigger'
import { sessionLinkOwnerRequest } from '../../../../shared/session-link-wait'
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
  const t = useTranslate()

  const [open, setOpen] = useState(dialogOnly)
  const [body, setBody] = useState('')
  const state = useSessionLink(sessionId, target, open)
  if (!state.supported) {
    return null
  }
  const snapshot = state.snapshot
  const link = snapshot?.link
  const ownerRequest = snapshot && sessionLinkOwnerRequest(snapshot.events)
  const unresolvedDelivery =
    snapshot?.events.some((event) => event.state === 'blocked' && event.retryable === false) ??
    false
  const limitPause =
    link?.state === 'paused' && ['turn-limit', 'message-limit'].includes(link.reason)
  const ownerMessageLabel = limitPause
    ? t('components.sessionLink.groupOptionalNote', 'Optional note to all participants')
    : t('components.sessionLink.groupOwnerMessage', 'Your message to all participants')
  const control = (action: 'pause' | 'resume' | 'stop' | 'end') => {
    if (link) {
      void state.mutate('orchestration.linkControl', { id: link.id, action, version: link.version })
    }
  }
  return (
    <>
      {!dialogOnly ? (
        <SessionLinkTrigger
          snapshot={snapshot}
          sessionId={sessionId}
          onOpen={() => setOpen(true)}
        />
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
            <DialogTitle>{t('components.sessionLink.title', 'Work together')}</DialogTitle>
            <DialogDescription>
              {t(
                'components.sessionLink.groupHostDescription',
                'Connect existing chats on this host. You control the story, permissions and continuation.'
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
          !snapshot.link.participants.some((p) => p.sessionId === initialPartnerSessionId) &&
          !state.groupSupported ? (
            <p role="alert" className="text-sm">
              {t(
                'components.sessionLink.otherLink',
                'This chat is already linked to another partner. End that link before connecting these two chats.'
              )}
            </p>
          ) : null}
          {snapshot ? (
            <div className="space-y-4">
              {!ownerRequest || link?.state === 'ended' ? (
                <>
                  <p className="whitespace-pre-wrap break-words text-sm font-medium">
                    {snapshot.link.story}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {snapshot.link.participants.map((p) => `${p.agent} · ${p.name}`).join(' ↔ ')}
                  </p>
                </>
              ) : null}
              <p role="status" className="text-sm">
                {sessionLinkStatus(snapshot, t)}
              </p>
              {ownerRequest && link?.state !== 'ended' ? (
                <SessionLinkOwnerDecision
                  key={ownerRequest.id}
                  request={ownerRequest}
                  link={snapshot.link}
                  disabled={state.busy || state.uncertain || unresolvedDelivery}
                  atomic={state.policySupported}
                  shouldFocus
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
              ) : null}
              <div className="flex flex-wrap gap-2">
                {!state.policySupported || !limitPause ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      state.busy ||
                      state.uncertain ||
                      link?.state === 'ended' ||
                      (link?.state === 'paused' && (unresolvedDelivery || Boolean(ownerRequest)))
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
                      ? t('components.sessionLink.continue', 'Continue link')
                      : t('components.sessionLink.pause', 'Pause')}
                  </Button>
                ) : null}
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
              {state.groupSupported && state.candidates && link?.state !== 'ended' ? (
                <SessionLinkAddParticipants
                  key={snapshot.link.id}
                  candidates={state.candidates.candidates.filter(
                    (p) =>
                      !snapshot.link.participants.some(
                        (member) => member.conversationId === p.conversationId
                      )
                  )}
                  busy={state.busy || state.uncertain}
                  initialSessionId={
                    initialPartnerSessionId &&
                    !snapshot.link.participants.some((p) => p.sessionId === initialPartnerSessionId)
                      ? initialPartnerSessionId
                      : undefined
                  }
                  onAdd={(sessionIds) =>
                    state.mutate('orchestration.linkAddParticipants', {
                      id: snapshot.link.id,
                      version: snapshot.link.version,
                      sessionIds
                    })
                  }
                />
              ) : null}
              {state.policySupported && snapshot.link.state !== 'ended' ? (
                <SessionLinkPolicySettings
                  key={`${snapshot.link.id}:${snapshot.link.version}`}
                  link={snapshot.link}
                  disabled={
                    state.busy || state.uncertain || Boolean(limitPause && unresolvedDelivery)
                  }
                  onSave={(policy, resume) =>
                    void state.mutate('orchestration.linkSetPolicy', {
                      id: snapshot.link.id,
                      version: snapshot.link.version,
                      policy,
                      resume
                    })
                  }
                />
              ) : null}
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
                {snapshot.link.turns}
                {snapshot.link.policy?.turnLimit === null
                  ? ''
                  : ` / ${snapshot.link.policy?.turnLimit ?? 6}`}{' '}
                {t('components.sessionLink.turns', 'automatic turns')} · {snapshot.link.messages}
                {snapshot.link.policy ? '' : ' / 12'}{' '}
                {t('components.sessionLink.messages', 'agent messages')}
              </p>
              {!ownerRequest ? (
                <>
                  <Textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    disabled={state.busy || state.uncertain || link?.state === 'ended'}
                    maxLength={8192}
                    aria-label={ownerMessageLabel}
                    placeholder={ownerMessageLabel}
                  />
                  <Button
                    variant={limitPause ? 'secondary' : 'default'}
                    disabled={
                      state.busy || state.uncertain || !body.trim() || link?.state === 'ended'
                    }
                    onClick={() => {
                      if (link) {
                        void state
                          .mutate(
                            link.state === 'paused' && state.policySupported
                              ? 'orchestration.linkControl'
                              : 'orchestration.linkSend',
                            link.state === 'paused' && state.policySupported
                              ? {
                                  id: link.id,
                                  version: link.version,
                                  action: 'resume',
                                  ownerMessage: body
                                }
                              : { id: link.id, body, kind: 'owner-note' }
                          )
                          .then((ok) => {
                            if (ok) {
                              setBody('')
                            }
                          })
                      }
                    }}
                  >
                    {link?.state === 'paused' && state.policySupported
                      ? t('components.sessionLink.sendResume', 'Send and continue')
                      : t('components.sessionLink.sendAll', 'Send to all')}
                  </Button>
                </>
              ) : null}
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
                policySupported={state.policySupported}
                groupSupported={state.groupSupported}
                onCreate={(partnerSessionIds, story, role, policy) =>
                  void state.mutate('orchestration.linkCreate', {
                    sessionId,
                    ...(state.groupSupported
                      ? { partnerSessionIds }
                      : { partnerSessionId: partnerSessionIds[0] }),
                    story,
                    role,
                    ...(policy ? { policy } : {})
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
