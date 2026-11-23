// @protected-copy: drawn inside the security-surface setup dialog
// The expired-token step: this desktop's own working sign-in first when it has one, else a short paste.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Info } from 'lucide-react'
import { isMac } from '@/app-shell/chrome/app-window-chrome'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import type { Bot } from '../../../../../shared/bot-types'
import { BotHowToAsk } from '../BotHowToAsk'
import { SlackConfigTokenForm } from './SlackConfigTokenForm'
import { useDeviceSignInLabel } from './slack-hand-off-parts'
import type { SlackHandOffOffer } from './use-slack-hand-off-offer'

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
    <span
      className="block truncate"
      // The full line on hover once it is cut short; read from what shows, since `text` is escaped.
      onPointerEnter={(event) => {
        event.currentTarget.title = event.currentTarget.textContent ?? ''
      }}
    >
      <BotHowToAsk text={text} />
    </span>
  )
}

/** The dialog's title on this step: what lapsed, and where, when this desktop's sign-in is offered. */
export function slackReconnectTitle(t: Translate, offeredOn: string | null): string {
  return offeredOn
    ? t('bots.slack.reconnect.expiredOnTitle', 'Slack sign-in expired on {{host}}', {
        host: offeredOn
      })
    : t('bots.slack.reconnect.expiredTitle', 'Slack token expired')
}

export function SlackReconnectStep({
  bot,
  hostName,
  offer,
  mine,
  ownEmail,
  error,
  onUse,
  onSubmit,
  onCancel
}: {
  bot: Bot
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
  const pasteRef = useRef<HTMLDivElement>(null)
  const offered = offer !== null && hostName !== null
  const device = useDeviceSignInLabel()
  // An offer arriving never hides the paste form someone is in: a token in the field, or focus
  // anywhere in the form, keeps the form open, unless they cancelled it themselves and have not
  // gone back to the form since.
  const [hasToken, setHasToken] = useState(false)
  const [inPasteForm, setInPasteForm] = useState(false)
  const [closedByUser, setClosedByUser] = useState(false)
  const [wasOffered, setWasOffered] = useState(offered)
  if (offered !== wasOffered) {
    setWasOffered(offered)
    if (offered && (hasToken || inPasteForm) && !closedByUser) {
      setPasting(true)
    }
  }
  // An offer arriving or going removes controls. Focus that was in this step, on one of them, goes
  // to where the step now asks for input: the field, or Sign in again while the field is behind
  // it. Focus on a control that stays (the ⓘ, the field), or outside the step, is left alone.
  const stepRef = useRef<HTMLDivElement>(null)
  const signInAgainRef = useRef<HTMLButtonElement>(null)
  const focusInStep = useRef(false)
  const focusedFor = useRef(offered)
  // Set while this step moves focus itself, so that is not taken for the user going back to the form.
  const movingFocus = useRef(false)
  useEffect(() => {
    // Whether focus is in the step. Focus moving anywhere says where it went. Focus moving to nothing
    // is checked once the moment settles: a control still shown and no longer focused was left (an
    // ordinary blur); one removed or hidden was taken away, and one still focused lost only its
    // window (switching apps), so focus still counts as in the step.
    const onFocusIn = (event: FocusEvent): void => {
      focusInStep.current =
        event.target instanceof Node && stepRef.current?.contains(event.target) === true
    }
    const onFocusOut = (event: FocusEvent): void => {
      const left = event.target
      if (event.relatedTarget !== null || !(left instanceof HTMLElement)) {
        return
      }
      queueMicrotask(() => {
        if (left.isConnected && !left.closest('[hidden]') && document.activeElement !== left) {
          focusInStep.current = false
        }
      })
    }
    focusInStep.current = stepRef.current?.contains(document.activeElement) === true
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [])
  useLayoutEffect(() => {
    if (focusedFor.current === offered) {
      return
    }
    focusedFor.current = offered
    const active = document.activeElement
    const lost =
      !active ||
      active === document.body ||
      (stepRef.current?.contains(active) === true && active.closest('[hidden]') !== null)
    if (focusInStep.current && lost) {
      const target =
        offered && !pasting ? signInAgainRef.current : pasteRef.current?.querySelector('input')
      movingFocus.current = true
      target?.focus()
      movingFocus.current = false
    }
  }, [offered, pasting])
  const kept = t(
    'bots.slack.reconnect.kept',
    'Orca Cloud keeps the new token encrypted, so your next bots here need one click.'
  )

  // One form at one place in the tree for both versions: an offer that arrives or goes while the
  // step is open only changes its props, so a token typed into it is kept.
  return (
    <div ref={stepRef} className="space-y-4">
      {offered && !pasting ? (
        <p className="text-sm">{device.question}</p>
      ) : (
        <LineWithWhy
          label={t('bots.slack.reconnect.about', 'About Slack tokens')}
          why={[why, kept]}
        >
          {mine
            ? isMac
              ? t('bots.slack.reconnect.mineMac', 'This Mac’s token expired. Paste a new one.')
              : t('bots.slack.reconnect.mine', 'This computer’s token expired. Paste a new one.')
            : t('bots.slack.reconnect.paste', 'Paste a new token to reconnect.')}
        </LineWithWhy>
      )}
      <div>
        {/* Hidden, not unmounted, while closed: a token typed before closing it is still there. */}
        <div
          onFocus={() => {
            setInPasteForm(true)
            // Back in the form: an earlier close no longer keeps it shut.
            if (!movingFocus.current) {
              setClosedByUser(false)
            }
          }}
          onBlur={(event) => {
            // Switching apps blurs the field but leaves it the focused element: still in the form.
            setInPasteForm(
              event.currentTarget.contains(event.relatedTarget) ||
                event.currentTarget.contains(document.activeElement)
            )
          }}
          ref={pasteRef}
          hidden={offered && !pasting}
        >
          <SlackConfigTokenForm
            compact
            // This desktop's own token is made with this computer's Slack login.
            hostId={mine ? LOCAL_EXECUTION_HOST_ID : bot.hostId}
            submitLabel={t('bots.slack.reconnect.submit', 'Reconnect')}
            busy={false}
            error={error}
            onSubmit={onSubmit}
            // A token already in the paste-only field stays in view when an offer arrives.
            onTokenChange={(token) => {
              setHasToken(token !== '')
              if (token !== '') {
                setClosedByUser(false)
              }
            }}
            // A refused paste comes back open, with focus on the field and its error; the
            // paste-only step focuses the field.
            autoFocusField={offered ? error !== null : true}
            // Cancel from Sign in again goes back to the offer.
            onCancel={
              offered
                ? () => {
                    setClosedByUser(true)
                    // The focused Cancel goes with the form: Sign in again takes focus.
                    flushSync(() => setPasting(false))
                    signInAgainRef.current?.focus()
                  }
                : onCancel
            }
          />
        </div>
      </div>
      {offered && !pasting ? (
        <DialogFooter>
          <Button
            ref={signInAgainRef}
            type="button"
            variant="outline"
            onClick={() => {
              setClosedByUser(false)
              // Signing in again is pasting a new token: the field takes focus once it shows.
              flushSync(() => setPasting(true))
              pasteRef.current?.querySelector('input')?.focus()
            }}
          >
            {t('bots.slack.reconnect.signInAgain', 'Sign in again')}
          </Button>
          {/* Not focused first: a stray Enter would spend this computer's sign-in. */}
          <Button
            type="button"
            className="min-w-0 shrink"
            title={device.use}
            onClick={() => onUse(offer.teamId)}
          >
            <span className="truncate">{device.use}</span>
          </Button>
        </DialogFooter>
      ) : null}
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
    <div className="flex min-w-0 items-center gap-0.5">
      <p className="flex min-w-0 overflow-hidden text-sm whitespace-pre">{children}</p>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="link-muted"
            size="icon-xs"
            className="size-5"
            aria-label={label}
          >
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
