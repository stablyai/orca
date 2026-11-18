// The card that sends a Composio trigger's events to one of the bot's webhooks: one click when the
// project sends its events nowhere yet, a question first when they go somewhere else, or by-hand steps.
import React, { useEffect, useState } from 'react'
import { Webhook } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  NativeChatCardAvatar,
  NativeChatCardFrame
} from '@/components/native-chat/NativeChatCardFrame'
import { useTranslate } from '@/i18n/use-translate'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import type { BotRef } from '@/lib/bot-hosts'
import { botToolErrorMessage } from '../bot-tools-client'
import type { ComposioSetupCardRef } from '../../../../../shared/composio/composio-setup-card'
import { GoogleSetupReceipt } from '../google/setup-cards/GoogleSetupCardParts'
import { ComposioEventsByHandSteps } from './ComposioEventsByHandSteps'
import {
  composioEventsByHand,
  readComposioEvents,
  setUpComposioEvents,
  type ComposioEventsStatus
} from './composio-client'

export type ComposioEventsView =
  | { status: 'loading' }
  | ({ status: 'ready' } & ComposioEventsStatus)
  | { status: 'error'; message: string }

/** What the card shows, from the host's answer and the owner's clicks in this window. */
export function ComposioEventsCardView({
  botName,
  triggerName,
  view,
  busy,
  error,
  byHandSteps,
  onSetUp,
  onByHand,
  onUndoByHand
}: {
  botName: string
  triggerName: string
  view: ComposioEventsView
  busy: boolean
  error: string | null
  /** The by-hand steps, once the owner chose them. */
  byHandSteps: React.ReactNode
  onSetUp: (replace: boolean) => void
  onByHand: () => void
  onUndoByHand: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const byHand = Boolean(byHandSteps)
  const done = view.status === 'ready' && view.target === 'ours' && view.on
  const other = view.status === 'ready' && view.target === 'other'
  const shownError = error ?? (view.status === 'error' ? view.message : null)
  return (
    <div>
      <NativeChatCardFrame
        avatar={
          <NativeChatCardAvatar>
            <Webhook className="size-4 text-muted-foreground" />
          </NativeChatCardAvatar>
        }
        heading={t('bots.composio.card.heading', 'Composio')}
      >
        <div className="mt-0.5 text-sm font-medium text-foreground">
          {t('bots.composio.events.title', 'Have Composio call {{bot}} on {{trigger}}', {
            bot: botName,
            trigger: triggerName
          })}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {other
            ? t(
                'bots.composio.events.replaceNote',
                'Your Composio project already sends its events to another address. Setting this up sends them here instead, and that address stops getting them.'
              )
            : t(
                'bots.composio.events.oneAddressNote',
                'Orca turns on {{trigger}} for your sign-in. Your Composio project’s events come to Orca at one address, and each goes to the bot it’s for.',
                { trigger: triggerName }
              )}
        </p>
        {shownError ? (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {shownError}
          </p>
        ) : null}
        {done ? null : byHand ? (
          byHandSteps
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button
              size="xs"
              disabled={busy || view.status === 'loading'}
              onClick={() => onSetUp(other)}
            >
              {other
                ? t('bots.composio.events.replace', 'Replace and set up')
                : t('bots.composio.events.setUp', 'Set it up')}
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={onByHand}>
              {t('bots.composio.events.byHand', 'I’ll do it in Composio')}
            </Button>
          </div>
        )}
      </NativeChatCardFrame>
      {done ? (
        <GoogleSetupReceipt text={t('bots.composio.events.done', '✓ Set up')} />
      ) : byHand ? (
        <GoogleSetupReceipt
          text={t('bots.composio.events.chosenByHand', 'Doing it in Composio')}
          onChange={onUndoByHand}
        />
      ) : null}
    </div>
  )
}

export function ComposioEventsCard({
  card,
  bot,
  botName
}: {
  card: ComposioSetupCardRef
  bot: BotRef
  botName: string
}): React.JSX.Element | null {
  const [view, setView] = useState<ComposioEventsView>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The owner's pick in this window; unpicked, an unsigned events hook means by hand was chosen
  // before. The steps always show the host's current hook, never one a key change left behind.
  const [picked, setPicked] = useState<'by-hand' | 'buttons' | null>(null)
  const { hookId, trigger } = card
  const slug = trigger?.slug
  const { hostId, id: botId } = bot
  useEffect(() => {
    if (!hookId || !slug) {
      return
    }
    let live = true
    const read = () =>
      void readComposioEvents({ hostId, id: botId }, hookId, slug).then(
        (status) => live && setView({ status: 'ready', ...status }),
        (caught: unknown) =>
          live && setView({ status: 'error', message: botToolErrorMessage(caught) })
      )
    read()
    const stopListening = onBotsChanged(read, hostId, { kinds: ['settings', 'bot'] })
    return () => {
      live = false
      stopListening()
    }
  }, [hostId, botId, hookId, slug])
  if (!hookId || !trigger) {
    return null
  }
  const ingress = view.status === 'ready' ? view.ingress : undefined
  const byHand = picked ? picked === 'by-hand' : ingress?.signed === false
  const byHandHookId = (byHand && ingress?.hookId) || null
  const setUp = (how: 'new' | 'replace' | { byHand: string }) => {
    setBusy(true)
    setError(null)
    void setUpComposioEvents(bot, hookId, trigger, how)
      .then((status) => setView({ status: 'ready', ...status }))
      .catch((caught: unknown) => setError(botToolErrorMessage(caught)))
      .finally(() => setBusy(false))
  }
  return (
    <ComposioEventsCardView
      botName={botName}
      triggerName={trigger.name}
      view={view}
      busy={busy}
      error={error}
      byHandSteps={
        byHandHookId ? (
          <ComposioEventsByHandSteps
            bot={bot}
            hookId={byHandHookId}
            botName={botName}
            triggerName={trigger.name}
            busy={busy}
            onDone={() => setUp({ byHand: byHandHookId })}
          />
        ) : null
      }
      onSetUp={(replace) => setUp(replace ? 'replace' : 'new')}
      onByHand={() => {
        setBusy(true)
        setError(null)
        void composioEventsByHand(bot, hookId)
          .then(() => readComposioEvents(bot, hookId, trigger.slug))
          .then((status) => {
            setView({ status: 'ready', ...status })
            setPicked('by-hand')
          })
          .catch((caught: unknown) => toast.error(botToolErrorMessage(caught)))
          .finally(() => setBusy(false))
      }}
      onUndoByHand={() => setPicked('buttons')}
    />
  )
}
