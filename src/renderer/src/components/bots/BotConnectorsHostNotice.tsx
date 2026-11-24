// The one notice above a server bot's connectors: why Slack, Linear and GitHub aren't reaching it
// and how to fix that from here. A bot on this computer keeps its own sign-in notice.
import React from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { readHostBots, useBotHostConnectorStatus } from '@/lib/bot-catalog'
import type { BotHostConnectorStatus } from '@/lib/bot-catalog-snapshot'
import {
  cancelBotHostSignIn,
  startBotHostSignIn,
  useBotHostOrcaAccount,
  useBotHostOrcaAccountSettled,
  useBotHostSignIn,
  type BotHostSignInView
} from '@/lib/bot-host-orca-account'
import { useBotHostHas, useBotHostVerified } from '@/lib/bot-host-status'
import { useAppStore } from '@/store'
import { BOTS_CONNECTORS_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import { botHasConnector, type Bot } from '../../../../shared/bot-types'
import { botLinkOwners } from '../../../../shared/bot-link-owners'
import { orcaCloudNeedsSignIn } from '../../../../shared/bots/host-orca-sign-in'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { OrcaAccountServerStatus } from '../../../../shared/orca-account-server-sign-in'
import { joinSentences } from '../../../../shared/text/sentence-joining'
import { useBotHostLabel } from './use-bot-host-label'
import { BotHostSignInBlocked, useBotHostSignInFromHere } from './bot-host-sign-in-from-here'
import { openBotConnectorsTab } from './bot-settings-open'

/** What the notice says for a server bot; null says nothing. */
export type BotHostNoticeState =
  /** `linkedTo`: the account the bot's links were made under (email null: not this window's
   *  and unnamed); null when it has none or the owner isn't known. */
  | { kind: 'signed-out'; linkedTo: { email: string | null } | null }
  | { kind: 'lapsed'; email: string | null }
  | { kind: 'unreachable' }
  | { kind: 'cant-save'; reason: string }
  | { kind: 'update-needed' }
  /** Its link waits on its sign-in, but its account couldn't be read: Try again reads it. */
  | { kind: 'unread' }
  /** A build without Orca Cloud sign-in, for links that need one. */
  | { kind: 'unconfigured' }
  | null

/** The notice for a server bot, from its host's own account, its connector and its Orca's version. */
export function botHostNoticeState(input: {
  account: OrcaAccountServerStatus | null
  connector: BotHostConnectorStatus | undefined
  /** null until the host's status is verified. */
  hasConnectorSetup: boolean | null
  /** Who each of the bot's links was made under (null: not recorded). */
  linkOwners: (string | null)[]
  own: { userId: string; email: string } | null
  /** Whether the host's account read has finished (failed or not). */
  settled: boolean
}): BotHostNoticeState {
  const { account, connector } = input
  if (input.hasConnectorSetup === null) {
    return null
  }
  if (!input.hasConnectorSetup) {
    return { kind: 'update-needed' }
  }
  if (!account) {
    // Still reading says nothing; a failed read says so only where the link waits on a sign-in.
    return input.settled && orcaCloudNeedsSignIn(connector) ? { kind: 'unread' } : null
  }
  if (account.state === 'unconfigured') {
    // Only where a sign-in would matter: the bot has links, or the link itself asks for one.
    return connector !== 'ok' && (input.linkOwners.length > 0 || orcaCloudNeedsSignIn(connector))
      ? { kind: 'unconfigured' }
      : null
  }
  if (account.state !== 'signed-in' && account.storage.kind === 'refused') {
    return { kind: 'cant-save', reason: account.storage.reason }
  }
  if (account.state === 'reconnect-required' || connector === 'needs-sign-in') {
    return { kind: 'lapsed', email: account.email ?? null }
  }
  if (account.state === 'signed-out') {
    return { kind: 'signed-out', linkedTo: linkedTo(input.linkOwners, account.email, input.own) }
  }
  if (connector === 'unreachable') {
    return { kind: 'unreachable' }
  }
  return null
}

/** The host forgets the email at an explicit sign-out; its links still record their account. */
function linkedTo(
  owners: (string | null)[],
  hostEmail: string | undefined,
  own: { userId: string; email: string } | null
): { email: string | null } | null {
  const known = owners.filter((owner): owner is string => owner !== null)
  if (owners.length === 0) {
    return null
  }
  if (hostEmail) {
    return { email: hostEmail }
  }
  if (known.length === 0) {
    return null
  }
  return own && known.every((owner) => owner === own.userId)
    ? { email: own.email }
    : { email: null }
}

/**
 * The sign-in moves to a bot's Connectors tab first. From Settings the browser page leaves
 * Settings; from a chat the setup dialog closes. The tab keeps the code, the failure, and Cancel
 * in view either way.
 */
export function showSignInBesidePage(hostId: ExecutionHostId, bot: Bot | null): void {
  const target = bot ?? readHostBots(hostId)[0]
  if (target) {
    openBotConnectorsTab(target)
  }
}

function SignInWaiting({
  hostId,
  view,
  firstSignIn,
  host
}: {
  hostId: ExecutionHostId
  view: Extract<BotHostSignInView, { phase: 'waiting' }>
  firstSignIn: boolean
  host: string
}): React.JSX.Element {
  const t = useTranslate()
  const code = view.prompt.userCode
  return (
    <div className="flex flex-col gap-1">
      <p role="status" className="flex items-start gap-1.5 text-muted-foreground">
        <Loader2 className="mt-0.5 size-3 shrink-0 animate-spin" />
        <span>
          {firstSignIn
            ? t(
                'bots.host.signIn.waitingFirst',
                'Log in with the Orca account {{host}} should use, in Orca’s browser for {{host}}. Check the page shows {{code}}.',
                { host, code }
              )
            : t(
                'bots.host.signIn.waiting',
                'Approve in Orca’s browser for {{host}}. Check the page shows {{code}}.',
                { host, code }
              )}
        </span>
      </p>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="xs"
          onClick={() =>
            void window.api.ui
              .writeClipboardText(view.prompt.verificationUrl)
              .then(() => toast.success(t('bots.host.signIn.copied', 'Link copied.')))
          }
        >
          {t('bots.host.signIn.copyLink', 'Copy link')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => cancelBotHostSignIn(hostId)}>
          {t('bots.host.signIn.cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  )
}

/** Sign in on the server, then its wait with the code to check, or why it stopped. */
export function BotHostSignInControl({
  hostId,
  host,
  bot,
  label,
  firstSignIn
}: {
  hostId: ExecutionHostId
  host: string
  bot: Bot | null
  label: string
  firstSignIn: boolean
}): React.JSX.Element {
  const signIn = useBotHostSignIn(hostId)
  if (signIn.phase === 'waiting') {
    return <SignInWaiting hostId={hostId} view={signIn} firstSignIn={firstSignIn} host={host} />
  }
  return (
    <div className="flex flex-col gap-1">
      {signIn.phase === 'failed' ? <p className="text-destructive">{signIn.error}</p> : null}
      <Button
        variant="outline"
        size="xs"
        className="self-start"
        disabled={signIn.phase === 'starting'}
        onClick={() => {
          showSignInBesidePage(hostId, bot)
          void startBotHostSignIn(hostId, bot ?? undefined)
        }}
      >
        {label}
      </Button>
    </div>
  )
}

/** A server's notice state and the account it read, for the notice and a chat card. */
export function useServerNoticeState(
  hostId: ExecutionHostId,
  bot: Bot | null
): {
  state: BotHostNoticeState
  account: OrcaAccountServerStatus | null
  connector: BotHostConnectorStatus | undefined
} {
  const account = useBotHostOrcaAccount(hostId)
  const settled = useBotHostOrcaAccountSettled(hostId)
  const connector = useBotHostConnectorStatus(hostId)
  const hasSetup = useBotHostHas(hostId, BOTS_CONNECTORS_RUNTIME_CAPABILITY)
  const hasConnectorSetup = useBotHostVerified(hostId) ? hasSetup : null
  const ownCloud = useAppStore((state) => state.orcaProfileAuthStatus?.cloud ?? null)
  const own = ownCloud ? { userId: ownCloud.userId, email: ownCloud.email } : null
  const state = botHostNoticeState({
    account,
    connector,
    hasConnectorSetup,
    linkOwners: bot ? botLinkOwners(bot) : [],
    own,
    settled
  })
  return { state, account, connector }
}

/**
 * A server's notice: for one of its bots, or (no bot) for all of them in Settings, where the group
 * header already says its account and version.
 */
function ServerNotice({
  hostId,
  host,
  bot
}: {
  hostId: ExecutionHostId
  host: string
  bot: Bot | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const signInFromHere = useBotHostSignInFromHere(hostId)
  const { state } = useServerNoticeState(hostId, bot)
  if (!state || (!bot && state.kind === 'update-needed')) {
    return null
  }
  const name = bot?.name ?? ''
  const lead = !bot
    ? t(
        'bots.host.notice.notReachingHost',
        'Slack, Linear and GitHub aren’t reaching bots on {{host}}.',
        {
          host
        }
      )
    : botHasConnector(bot)
      ? t('bots.host.notice.notReaching', 'Slack, Linear and GitHub aren’t reaching {{name}}.', {
          name
        })
      : null
  const line = (text: string): React.JSX.Element => (
    <p>{lead ? joinSentences([lead, text]) : text}</p>
  )
  const signInButton = (label: string): React.JSX.Element | null =>
    signInFromHere === null ? null : signInFromHere !== 'start' ? (
      <BotHostSignInBlocked hostId={hostId} host={host} why={signInFromHere} />
    ) : (
      <BotHostSignInControl
        hostId={hostId}
        host={host}
        bot={bot}
        label={label}
        firstSignIn={state.kind === 'signed-out'}
      />
    )
  const body = ((): React.JSX.Element => {
    switch (state.kind) {
      case 'update-needed':
        return (
          <p>
            {t(
              'bots.host.notice.updateNeeded',
              'Update Orca on {{host}} to set up {{name}}’s connectors from here.',
              { host, name }
            )}
          </p>
        )
      case 'unread':
      case 'unconfigured':
        // What a sign-in from here waits on, and (unread) Try again.
        return (
          <>
            {lead ? <p>{lead}</p> : null}
            <BotHostSignInBlocked hostId={hostId} host={host} why={state.kind} />
          </>
        )
      case 'unreachable':
        return line(t('bots.host.notice.unreachable', '{{host}} can’t reach Orca Cloud.', { host }))
      case 'cant-save':
        return (
          <>
            {line(
              t('bots.host.notice.cantSave', '{{host}} can’t save an Orca sign-in: {{reason}}', {
                host,
                reason: state.reason
              })
            )}
            <p>
              {t(
                'bots.host.notice.cantSaveNext',
                'Unlock or set up a keychain on {{host}} and restart Orca there, then sign it in here.',
                { host }
              )}
            </p>
          </>
        )
      case 'lapsed':
        return (
          <>
            {line(
              state.email
                ? t('bots.host.notice.lapsed', '{{host}}’s Orca sign-in for {{email}} changed.', {
                    host,
                    email: state.email
                  })
                : t('bots.host.notice.lapsedNoEmail', '{{host}}’s Orca sign-in changed.', {
                    host
                  })
            )}
            {signInButton(t('bots.host.signIn.again', 'Sign {{host}} in again', { host }))}
          </>
        )
      case 'signed-out':
        return (
          <>
            {lead
              ? line(
                  joinSentences(
                    [
                      t('bots.host.notice.signedOut', '{{host}} is signed out of Orca.', { host }),
                      state.linkedTo?.email === null
                        ? t(
                            'bots.host.notice.linksBelongElsewhere',
                            '{{name}}’s connectors belong to another Orca account.',
                            { name }
                          )
                        : state.linkedTo?.email
                          ? t(
                              'bots.host.notice.linksBelong',
                              '{{name}}’s connectors belong to {{email}}.',
                              { name, email: state.linkedTo.email }
                            )
                          : ''
                    ].filter(Boolean)
                  )
                )
              : line(
                  t(
                    'bots.host.notice.signedOutFirst',
                    '{{host}} is signed out of Orca, so {{name}} can’t use Slack, Linear or GitHub yet.',
                    { host, name }
                  )
                )}
            {signInButton(t('bots.host.signIn.start', 'Sign in on {{host}}', { host }))}
            {bot && lead ? null : (
              <p>
                {t(
                  'bots.host.signIn.trust',
                  'Anyone paired to {{host}} can use its account’s connectors.',
                  { host }
                )}
              </p>
            )}
          </>
        )
    }
  })()
  return (
    <div role="status" className="flex flex-col gap-1.5 px-2 py-1.5 text-xs text-muted-foreground">
      {body}
    </div>
  )
}

/** A server bot's notice; a bot on this computer has BotCloudSignInNotice. */
export function BotConnectorsHostNotice({ bot }: { bot: Bot }): React.JSX.Element | null {
  const host = useBotHostLabel(bot.hostId)
  return host ? <ServerNotice hostId={bot.hostId} host={host} bot={bot} /> : null
}

/** Settings › Bots: why a server's bots aren't reached, and its sign-in, for all of its bots. */
export function BotHostSignInNotice({
  hostId,
  host
}: {
  hostId: ExecutionHostId
  host: string
}): React.JSX.Element | null {
  return <ServerNotice hostId={hostId} host={host} bot={null} />
}
