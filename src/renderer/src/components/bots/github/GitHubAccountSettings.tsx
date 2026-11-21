import React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { SettingsSubsectionHeader } from '@/components/settings/form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostLabel } from '../use-bot-host-label'
import { useHostBots } from '@/lib/bot-catalog'
import { botGitHubCalls } from '@/lib/bot-connector-host-calls'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { connectAnotherAccount, useConnectorConnect } from '@/lib/connector-connect-state'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { awaitGitHubChange, refreshBotGitHub, useBotGitHub } from '@/lib/bot-github-state'
import { GITHUB_INSTALL_FOLLOW } from '@/lib/bot-github-install-record'
import { openBotHostPageOrSay } from '@/lib/bot-host-page'
import {
  type ConnectorGitHubLinkedAccount,
  gitHubLinkedAccounts
} from '../../../../../shared/connector-bot-github-contract'
import { STATUS_DOT_CLASSES } from '../bot-connector-row-parts'
import { botGitHubErrorMessage } from './bot-github-copy'

// Select items need a non-empty value.
const ASK_EACH_TIME = 'ask'

/** The default is one of the bots turned on for GitHub. */
function DefaultBotPicker({
  hostId,
  defaultBotId,
  userId
}: {
  hostId: ExecutionHostId
  defaultBotId: string | null
  /** The linked GitHub user whose default this is; none for an older cloud's one link. */
  userId: string | undefined
}): React.JSX.Element {
  const t = useTranslate()
  const hostName = useBotHostLabel(hostId)
  // The host's account, so only its own bots.
  const bots = useHostBots(hostId).filter((bot) => bot.github)
  const label = t('bots.github.account.defaultBot', 'Default bot for my requests')
  // The default is the account's, so it may be a bot another of the owner's computers hosts.
  const elsewhere =
    defaultBotId && !bots.some((bot) => bot.id === defaultBotId) ? defaultBotId : null

  const choose = async (value: string): Promise<void> => {
    const result = await botGitHubCalls(hostId).setDefaultBot({
      botId: value === ASK_EACH_TIME ? null : value,
      userId
    })
    if (!result.ok) {
      toast.error(botGitHubErrorMessage(result.error, hostName))
    }
    await refreshBotGitHub(hostId)
  }

  return (
    <Select value={defaultBotId ?? ASK_EACH_TIME} onValueChange={(v) => void choose(v)}>
      <SelectTrigger size="sm" aria-label={label} className="min-w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ASK_EACH_TIME}>
          {t('bots.github.account.askEachTime', 'Ask which bot')}
        </SelectItem>
        {bots.map((bot) => (
          <SelectItem key={bot.id} value={bot.id}>
            {bot.name}
          </SelectItem>
        ))}
        {elsewhere ? (
          <SelectItem value={elsewhere}>
            {t('bots.github.account.otherComputer', 'A bot on another computer')}
          </SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  )
}

/** One linked GitHub user: its default agent, or the install it lacks, and Reconnect and Unlink. */
function GitHubLoginRow({
  hostId,
  hostName,
  login,
  userId,
  installUrl
}: {
  hostId: ExecutionHostId
  hostName: string | null
  login: ConnectorGitHubLinkedAccount
  /** Sent to the cloud only when it links several users; an older one has just this one. */
  userId: string | undefined
  /** Set when this user sees no installation of the Orca app. */
  installUrl: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const connect = useConnectorConnect(hostId, 'github')

  const unlink = async (): Promise<void> => {
    const result = await botGitHubCalls(hostId).unlink({ userId })
    if (!result.ok) {
      toast.error(botGitHubErrorMessage(result.error, hostName))
    }
    await refreshBotGitHub(hostId)
  }
  // A wrong user is fixed by signing in again as the right one; its sign-in replaces this link.
  const reconnect = (): void =>
    void connectAnotherAccount(hostId, 'github', () => botGitHubCalls(hostId).unlink({ userId }))

  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {t('bots.github.account.linkedAs', 'Linked as {{login}}', { login: login.login })}
        </p>
        {installUrl ? (
          <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            <span className={STATUS_DOT_CLASSES.attention} aria-hidden />
            {t('settings.bots.githubStatus.notInstalled', 'Orca not installed')}
          </p>
        ) : (
          <p className="truncate text-xs text-muted-foreground">
            {hostName
              ? t('bots.github.account.linkedOnHost', 'Linked to {{host}}’s Orca account', {
                  host: hostName
                })
              : t('bots.github.account.linked', 'Linked to this Orca account')}
          </p>
        )}
      </div>
      {installUrl ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            // The row follows GitHub until the install shows, as the setup dialog does.
            if (openBotHostPageOrSay(hostId, installUrl, { local: 'system' }) !== 'unrouted') {
              awaitGitHubChange(hostId, undefined, GITHUB_INSTALL_FOLLOW)
            }
          }}
        >
          {t('bots.github.connection.finishSetup', 'Finish setup')}
        </Button>
      ) : (
        <DefaultBotPicker hostId={hostId} defaultBotId={login.defaultBotId} userId={userId} />
      )}
      {isPairedWebClientWindow() ? null : (
        <Button
          size="sm"
          variant="outline"
          disabled={connect.status === 'waiting'}
          onClick={reconnect}
        >
          {t('bots.github.account.reconnect', 'Reconnect')}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => void unlink()}>
        {t('bots.github.account.unlink', 'Unlink')}
      </Button>
    </div>
  )
}

/**
 * Settings › GitHub: the GitHub users a host's Orca account is linked as, each with its default
 * agent. `hostName` names a paired server; null is this computer.
 */
export function GitHubAccountSettings({
  hostId,
  hostName
}: {
  hostId: ExecutionHostId
  hostName: string | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const view = useBotGitHub(hostId)
  const connect = useConnectorConnect(hostId, 'github')

  // Until the cloud has GitHub, the Connectors list says "Coming soon".
  if (view.status === 'off' || view.status === 'loading') {
    return null
  }
  const logins = view.status === 'ready' ? gitHubLinkedAccounts(view.github) : []
  const several = logins.length > 1
  const header = (
    <SettingsSubsectionHeader
      title={t('bots.github.account.title', 'GitHub')}
      description={
        hostName
          ? several
            ? t(
                'bots.github.account.descriptionOnHostPlural',
                'The GitHub users {{host}}’s bots work as and are owned by.',
                { host: hostName }
              )
            : t(
                'bots.github.account.descriptionOnHost',
                'The GitHub user {{host}}’s bots work as and are owned by.',
                { host: hostName }
              )
          : several
            ? t(
                'bots.github.account.descriptionPlural',
                'Your GitHub accounts, so your bots know which comments are yours.'
              )
            : t(
                'bots.github.account.description',
                'Your GitHub account, so your bots know which comments are yours.'
              )
      }
    />
  )
  if (view.status === 'failed') {
    return (
      <section className="space-y-3">
        {header}
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            {botGitHubErrorMessage(view.error, hostName)}
          </p>
          <Button size="sm" variant="outline" onClick={() => void refreshBotGitHub(hostId)}>
            {t('bots.github.setup.retry', 'Try again')}
          </Button>
        </div>
      </section>
    )
  }
  const { accounts, installUrl } = view.github
  return (
    <section className="space-y-3">
      {header}
      {logins.length > 0 ? (
        <div className="divide-y divide-border rounded-md border border-border">
          {logins.map((login) => (
            <GitHubLoginRow
              key={login.userId}
              hostId={hostId}
              hostName={hostName}
              login={login}
              userId={accounts ? login.userId : undefined}
              installUrl={login.installations.length === 0 ? installUrl : null}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {isPairedWebClientWindow()
            ? t(
                'bots.github.account.linkFromApp',
                'Link GitHub from Orca on a computer paired to {{host}}.',
                { host: hostName ?? '' }
              )
            : t(
                'bots.github.account.unlinked',
                'Add GitHub from a bot’s Connectors to link your account.'
              )}
        </p>
      )}
      {connect.status === 'failed' ? (
        <p role="alert" className="text-sm text-destructive">
          {botGitHubErrorMessage(connect.error, hostName)}
        </p>
      ) : null}
    </section>
  )
}
