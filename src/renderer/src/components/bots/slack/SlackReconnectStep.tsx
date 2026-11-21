// @protected-copy: drawn inside the security-surface setup dialog
// The expired-token step: this desktop's own working token first when it has one, else a short paste.
import React, { useState } from 'react'
import { Trans } from 'react-i18next'
import { ChevronRight, Info } from 'lucide-react'
import { isMac } from '@/app-shell/chrome/app-window-chrome'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DialogFooter } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { i18n } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { BotHowToAsk } from '../BotHowToAsk'
import { SlackConfigTokenForm } from './SlackConfigTokenForm'
import type { SlackHandOffOffer } from './use-slack-hand-off-offer'
import { useSlackTeamName } from './SlackWorkspacesSettings'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'

/** This desktop's own Orca account, offered for the one workspace whose token lapsed on the host. */
export type SlackReconnectOffer = { email: string; teamId: string }

/** Offered only for the one workspace whose token lapsed, on a named computer. */
export function slackReconnectOffer(
  offer: SlackHandOffOffer | null,
  hostName: string | null
): SlackReconnectOffer | null {
  return offer && hostName && offer.teamIds.length === 1
    ? { email: offer.email, teamId: offer.teamIds[0] }
    : null
}

/** The header's "for <bot> on <computer>" on one line, as the body: long names end in an ellipsis. */
export function SlackOneLineIntro({ text }: { text: string }): React.JSX.Element {
  return (
    <span className="block truncate">
      <BotHowToAsk text={text} />
    </span>
  )
}

/** The dialog's title on this step: the question when this desktop's token is offered. */
export function slackReconnectTitle(t: Translate, offered: boolean): string {
  if (!offered) {
    return t('bots.slack.reconnect.expiredTitle', 'Slack token expired')
  }
  return isMac
    ? t('bots.slack.reconnect.useTitleMac', 'Use your Mac’s token?')
    : t('bots.slack.reconnect.useTitle', 'Use this computer’s token?')
}

export function SlackReconnectStep({
  hostName,
  offer,
  mine,
  ownEmail,
  error,
  onUse,
  onSubmit,
  onCancel
}: {
  hostName: string | null
  /** Set only with `hostName`: whose token lapsed is named in the line. */
  offer: SlackReconnectOffer | null
  /** The lapsed token is this desktop's own Orca account's, from a hand-off. */
  mine: boolean
  /** This desktop's own Orca account. */
  ownEmail: string | null
  error: string | null
  onUse: (teamId: string) => void
  onSubmit: (token: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useTranslate()
  // A refused paste comes back here with its error: the field stays in view.
  const [pasting, setPasting] = useState(error !== null)
  // The workspace Use it puts the app in, by name, as this desktop's own bots there read it.
  const offerTeam = offer?.teamId ?? ''
  const workspace = useSlackTeamName(LOCAL_EXECUTION_HOST_ID, offerTeam)
  const why =
    mine && ownEmail
      ? t(
          'bots.slack.reconnect.whyMine',
          'Each computer keeps its own Slack token. Slack stopped accepting the one {{email}} uses.',
          { email: ownEmail }
        )
      : hostName
        ? t(
            'bots.slack.reconnect.whyHost',
            'Each computer keeps its own Slack token. Slack stopped accepting the one {{host}} uses.',
            { host: hostName }
          )
        : t('bots.slack.reconnect.why', 'Slack stopped accepting this workspace’s saved token.')
  const form = (compactProps: { onCancel?: () => void }) => (
    <SlackConfigTokenForm
      compact
      submitLabel={t('bots.slack.reconnect.submit', 'Reconnect')}
      busy={false}
      error={error}
      onSubmit={onSubmit}
      {...compactProps}
    />
  )

  if (offer && hostName) {
    return (
      <div className="space-y-4">
        <LineWithWhy
          label={t('bots.slack.reconnect.about', 'About Slack tokens')}
          why={[
            why,
            // Its id until the name is known: then the line without it.
            workspace && workspace !== offerTeam
              ? t(
                  'bots.slack.reconnect.useDetailIn',
                  'Use it sets up this bot’s Slack app in {{workspace}} with {{email}}’s token. {{host}} only gets this bot’s app.',
                  { workspace, email: offer.email, host: hostName }
                )
              : t(
                  'bots.slack.reconnect.useDetail',
                  'Use it sets up this bot’s Slack app with {{email}}’s token. {{host}} only gets this bot’s app.',
                  { email: offer.email, host: hostName }
                )
          ]}
        >
          <Trans
            i18n={i18n}
            defaults={
              isMac
                ? t(
                    'bots.slack.reconnect.hostExpiredMac',
                    '<host>{{host}}</host>’s expired. This Mac’s works.'
                  )
                : t(
                    'bots.slack.reconnect.hostExpired',
                    '<host>{{host}}</host>’s expired. This computer’s works.'
                  )
            }
            values={{ host: hostName }}
            components={{
              host: (
                // The name gives way first, so the rest of the line stays whole.
                <span className="min-w-0 truncate" title={hostName} />
              )
            }}
          />
        </LineWithWhy>
        <Collapsible open={pasting} onOpenChange={setPasting}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="link-muted" size="inline">
              {t('bots.slack.reconnect.pasteInstead', 'Paste a token instead')}
              <ChevronRight className={cn('transition-transform', pasting && 'rotate-90')} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {/* Open, the form's Cancel · Reconnect is the one footer, and Use it steps aside. */}
            <div className="pt-3">{form({ onCancel })}</div>
          </CollapsibleContent>
        </Collapsible>
        {pasting ? null : (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              {t('bots.slack.setup.cancel', 'Cancel')}
            </Button>
            {/* Not autofocused: Enter must never hand off this account's token unseen. */}
            <Button type="button" onClick={() => onUse(offer.teamId)}>
              {t('bots.slack.reconnect.use', 'Use it')}
            </Button>
          </DialogFooter>
        )}
      </div>
    )
  }

  const kept = t(
    'bots.slack.reconnect.kept',
    'Orca Cloud keeps the new token encrypted, so your next bots here need one click.'
  )
  return (
    <div className="space-y-4">
      <LineWithWhy label={t('bots.slack.reconnect.about', 'About Slack tokens')} why={[why, kept]}>
        {mine
          ? isMac
            ? t('bots.slack.reconnect.mineMac', 'This Mac’s token expired. Paste a new one.')
            : t('bots.slack.reconnect.mine', 'This computer’s token expired. Paste a new one.')
          : t('bots.slack.reconnect.paste', 'Paste a new token to reconnect.')}
      </LineWithWhy>
      {form({ onCancel })}
    </div>
  )
}

/** One line, never wrapping, with an ⓘ whose tooltip says why (on hover and keyboard focus). */
function LineWithWhy({
  label,
  why,
  children
}: {
  label: string
  why: (string | null)[]
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <p className="flex min-w-0 overflow-hidden text-sm whitespace-pre">{children}</p>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="link-muted" size="icon-xs" aria-label={label}>
            <Info className="size-3.5" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4} className="max-w-xs text-left">
          <div className="space-y-1">
            {why.map((line) => (line ? <p key={line}>{line}</p> : null))}
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
