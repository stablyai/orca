import React from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
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
import { refreshBotGitHub, useBotGitHub } from '@/lib/bot-github-state'
import { botGitHubErrorMessage } from './bot-github-copy'
import type { ConnectorGitHubLinkedAccount } from '../../../../../shared/connector-bot-github-contract'

// Select items need a non-empty value.
const ASK_EACH_TIME = 'ask'

/** The default is one of the bots turned on for GitHub. */
function DefaultBotPicker({
  hostId,
  defaultBotId
}: {
  hostId: ExecutionHostId
  defaultBotId: string | null
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
      botId: value === ASK_EACH_TIME ? null : value
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

/**
 * Every Orca account linked to the same GitHub login, by its computers' names, this one marked and
 * the only one that can be unlinked from here. Each one's managed agents answer that login's requests.
 */
function LinkedOrcaAccounts({
  login,
  accounts,
  onUnlink
}: {
  login: string
  accounts: ConnectorGitHubLinkedAccount[]
  onUnlink: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        {t('bots.github.account.linkedAccounts', 'Orca accounts linked to {{login}}', { login })}
      </p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {accounts.map((account) => (
          <li
            key={`${account.linkedAt}:${account.current}:${account.machines.join('\n')}`}
            className="flex min-h-12 items-center gap-3 px-3 py-2"
          >
            <p className="min-w-0 flex-1 truncate text-sm">
              {account.machines.length > 0
                ? account.machines.join(', ')
                : t('bots.github.account.noComputers', 'No computers yet')}
            </p>
            {account.current ? (
              <>
                <Badge variant="outline">
                  {t('bots.github.account.thisAccount', 'This account')}
                </Badge>
                <Button size="sm" variant="ghost" onClick={onUnlink}>
                  {t('bots.github.account.unlink', 'Unlink')}
                </Button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Settings › Bots › GitHub: the GitHub account a host's Orca account is linked as, and its default
 * bot. `hostName` names a paired server; null is this computer.
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

  const unlink = async (): Promise<void> => {
    const result = await botGitHubCalls(hostId).unlink()
    if (!result.ok) {
      toast.error(botGitHubErrorMessage(result.error, hostName))
    }
    await refreshBotGitHub(hostId)
  }
  // A wrong user is fixed by signing in again as the right one; its sign-in replaces the link.
  const reconnect = (): void =>
    void connectAnotherAccount(hostId, 'github', () => botGitHubCalls(hostId).unlink())

  // Until the cloud has GitHub, the Connectors list says "Coming soon".
  if (view.status === 'off' || view.status === 'loading') {
    return null
  }
  const header = (
    <SettingsSubsectionHeader
      title={t('bots.github.account.title', 'GitHub')}
      description={
        hostName
          ? t(
              'bots.github.account.descriptionOnHost',
              'The GitHub user {{host}}’s bots work as and are owned by.',
              { host: hostName }
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
  const { account, defaultBotId } = view.github
  // Linked from other Orca accounts too: Unlink moves to this account's row in their list.
  const linkedAccounts =
    account && (view.github.linkedAccounts?.length ?? 0) > 1
      ? (view.github.linkedAccounts ?? [])
      : null
  return (
    <section className="space-y-3">
      {header}
      {account ? (
        <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {t('bots.github.account.linkedAs', 'Linked as {{login}}', { login: account.login })}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {hostName
                ? t('bots.github.account.linkedOnHost', 'Linked to {{host}}’s Orca account', {
                    host: hostName
                  })
                : t('bots.github.account.linked', 'Linked to this Orca account')}
            </p>
          </div>
          <DefaultBotPicker hostId={hostId} defaultBotId={defaultBotId} />
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
          {linkedAccounts ? null : (
            <Button size="sm" variant="ghost" onClick={() => void unlink()}>
              {t('bots.github.account.unlink', 'Unlink')}
            </Button>
          )}
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
      {account && linkedAccounts ? (
        <LinkedOrcaAccounts
          login={account.login}
          accounts={linkedAccounts}
          onUnlink={() => void unlink()}
        />
      ) : null}
      {connect.status === 'failed' ? (
        <p role="alert" className="text-sm text-destructive">
          {botGitHubErrorMessage(connect.error, hostName)}
        </p>
      ) : null}
    </section>
  )
}
