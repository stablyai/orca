// @protected-copy: drawn inside the security-surface setup dialog
// The paired-computer pieces of Slack setup: the quiet line offering this desktop's Orca account's
// token, and the install link to copy for approving in another browser.
import React from 'react'
import { isMac } from '@/app-shell/chrome/app-window-chrome'
import { Button } from '@/components/ui/button'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { useTranslate } from '@/i18n/use-translate'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { useSlackTeamName } from './SlackWorkspacesSettings'
import type { SlackInstallLink } from './slack-install-link'

/** One line per workspace, never a button: today's form stays the main path. */
export function SlackHandOffLines({
  email,
  teamIds,
  onUse
}: {
  email: string
  teamIds: readonly string[]
  onUse: (teamId: string) => void
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      {teamIds.map((teamId) => (
        <SlackHandOffLine key={teamId} email={email} teamId={teamId} onUse={onUse} />
      ))}
    </div>
  )
}

function SlackHandOffLine({
  email,
  teamId,
  onUse
}: {
  email: string
  teamId: string
  onUse: (teamId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  // Named as this computer's own bots read it.
  const workspace = useSlackTeamName(LOCAL_EXECUTION_HOST_ID, teamId)
  return (
    <p className="text-xs text-muted-foreground">
      {isMac
        ? t(
            'bots.slack.handOff.offerMac',
            'This Mac is signed in to Orca as {{email}}, which already has a token for {{workspace}}.',
            { email, workspace }
          )
        : t(
            'bots.slack.handOff.offer',
            'This computer is signed in to Orca as {{email}}, which already has a token for {{workspace}}.',
            { email, workspace }
          )}{' '}
      <Button type="button" variant="link" size="inlineText" onClick={() => onUse(teamId)}>
        {t('bots.slack.handOff.use', 'Use it →')}
      </Button>
    </p>
  )
}

/** While Use it runs: whose token makes the app, and that the computer gets only this bot's app. */
export function SlackHandOffConfirm({
  email,
  host
}: {
  email: string
  host: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <p className="text-sm">
      {isMac
        ? t(
            'bots.slack.handOff.confirmMac',
            'Orca on this Mac creates the Slack app with {{email}}’s token. {{host}} gets only this bot’s app.',
            { email, host }
          )
        : t(
            'bots.slack.handOff.confirm',
            'Orca on this computer creates the Slack app with {{email}}’s token. {{host}} gets only this bot’s app.',
            { email, host }
          )}
    </p>
  )
}

/** "Copy link (works once, until 3:42 PM).", then "Link copied". */
export function SlackCopyLink({
  link,
  copied,
  onCopy
}: {
  link: SlackInstallLink
  copied: boolean
  onCopy: () => Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const until =
    link.expiresAt === null
      ? null
      : uiDateTimeFormat({ hour: 'numeric', minute: '2-digit' }).format(link.expiresAt)
  return (
    <>
      {copied ? (
        <span>{t('bots.slack.setup.linkCopied', 'Link copied')}</span>
      ) : (
        <Button type="button" variant="link" size="inlineText" onClick={() => void onCopy()}>
          {t('bots.slack.setup.copyLink', 'Copy link')}
        </Button>
      )}{' '}
      {until
        ? t('bots.slack.setup.linkUntil', '(works once, until {{time}}).', { time: until })
        : t('bots.slack.setup.linkOnce', '(works once).')}
    </>
  )
}
