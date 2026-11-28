// Settings › Bots below the switches: each Orca account's Slack, Linear and GitHub once, then each
// computer's own group (its Enable switch, connectors, Google and Composio key).
import React, { useState } from 'react'
import { ChevronDown, ChevronRight, Laptop, Server, UserRound } from 'lucide-react'
import {
  ACCOUNT_CONNECTORS,
  type BotConnector,
  useBotConnectorAvailable
} from '@/components/bots/bot-connectors'
import { BotHostSignInNotice } from '@/components/bots/BotConnectorsHostNotice'
import { ComposioKeyControl } from '@/components/bots/composio/ComposioKeyControl'
import { useComposioEventsHolder } from '@/components/bots/composio/composio-key-client'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { GitHubAccountSettings } from '@/components/bots/github/GitHubAccountSettings'
import { GoogleAccountSettings } from '@/components/bots/google/GoogleAccountSettings'
import { useGoogleHost } from '@/components/bots/google/google-connect-client'
import { LinearAccountSettings } from '@/components/bots/linear/LinearAccountSettings'
import {
  slackWorkspaces,
  SlackWorkspacesSettings
} from '@/components/bots/slack/SlackWorkspacesSettings'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useHostBots } from '@/lib/bot-catalog'
import { useBotHostOrcaAccount } from '@/lib/bot-host-orca-account'
import { botHostTarget } from '@/lib/bot-hosts'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { SettingsSubsectionHeader, SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import type { BotSettingsAccount, BotSettingsComputer } from './bot-settings-computers'
import { useServerBotsEnabled } from './use-server-bots-enabled'
import { BotAvatar } from '@/components/bots/BotAvatar'
import { botAgentLabel } from '@/components/bots/bot-presentation'
import { openBotSettingsPage } from '@/components/bots/bot-settings-open'
import {
  SettingsInsetGroup,
  SettingsInsetRow
} from '@/components/bots/settings-view/BotSettingsRows'

/** One group: an icon, its name, then what it is or why it is closed; open unless it has no body. */
function SettingsGroup({
  icon: Icon,
  title,
  detail,
  children
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  detail: string | null
  children?: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const header = (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <h3 className="shrink-0 text-sm font-semibold">{title}</h3>
      {detail ? (
        <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">
          · {detail}
        </span>
      ) : null}
    </span>
  )
  return (
    <section className="border-t border-border pt-6 first:border-t-0 first:pt-0">
      {children ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger variant="row">
            {header}
            {open ? (
              <ChevronDown className="size-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 text-muted-foreground" />
            )}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-4 space-y-6">{children}</div>
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <div className="flex items-center py-2">{header}</div>
      )}
    </section>
  )
}

/** An Orca account's Slack workspaces, Linear and GitHub, answered by one computer on it. */
export function BotAccountGroup({ account }: { account: BotSettingsAccount }): React.JSX.Element {
  const t = useTranslate()
  const computers = account.computers.join(', ')
  return (
    <SettingsGroup
      icon={UserRound}
      title={account.email ?? t('settings.bots.group.noAccount', 'Orca account')}
      detail={
        !account.email
          ? t('settings.bots.group.notSignedIn', 'Not signed in · {{computers}}', { computers })
          : account.own
            ? t('settings.bots.group.yourAccount', 'your account · {{computers}}', { computers })
            : computers
      }
    >
      <SlackWorkspacesSettings
        hostId={account.hostId}
        botHostIds={account.hostIds}
        account={account.email}
      />
      <LinearAccountSettings hostId={account.hostId} hostName={account.hostName} />
      <GitHubAccountSettings hostId={account.hostId} hostName={account.hostName} />
    </SettingsGroup>
  )
}

function connectorSummary(
  id: BotConnector['id'],
  bots: readonly Bot[],
  googleConnected: boolean
): string {
  const connected =
    id === 'linear'
      ? bots.some((bot) => bot.linear)
      : id === 'github'
        ? bots.some((bot) => bot.github)
        : id === 'google'
          ? googleConnected
          : slackWorkspaces(bots).length > 0
  if (connected) {
    return translate('settings.bots.slackConnected', 'Connected')
  }
  return id === 'linear'
    ? translate('settings.bots.noLinearBots', 'No bots on Linear yet')
    : id === 'github'
      ? translate('settings.bots.noGitHubBots', 'No bots on GitHub yet')
      : id === 'google'
        ? translate('settings.bots.googleNotConnected', 'Not connected yet')
        : translate('settings.bots.noSlackWorkspaces', 'No Slack workspaces yet')
}

/** Where people can reach one computer's bots, and why not when its server isn't signed in. */
function ComputerConnectors({ computer }: { computer: BotSettingsComputer }): React.JSX.Element {
  const t = useTranslate()
  const bots = useHostBots(computer.hostId)
  const available = useBotConnectorAvailable(computer.hostId)
  const google = useGoogleHost(botHostTarget(computer.hostId))
  const googleConnected = google.status === 'ready' && google.google.accounts.length > 0
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={t('settings.bots.connectors', 'Connectors')}
        description={
          computer.local
            ? t('settings.bots.connectorsDescription', 'Where people can reach your bots.')
            : t('settings.bots.connectorsOnHost', 'Where people can reach the bots on {{host}}.', {
                host: computer.name
              })
        }
      />
      {computer.local ? null : (
        <BotHostSignInNotice hostId={computer.hostId} host={computer.name} />
      )}
      <ul className="divide-y divide-border rounded-md border border-border">
        {ACCOUNT_CONNECTORS.map((connector) => (
          <li
            key={connector.id}
            aria-disabled={!available(connector)}
            className="flex items-center gap-3 px-3 py-2.5 text-sm aria-disabled:text-muted-foreground"
          >
            <connector.Icon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">{connector.label}</span>
            <span className="text-xs text-muted-foreground">
              {available(connector)
                ? connectorSummary(connector.id, bots, googleConnected)
                : t('settings.bots.comingSoon', 'Coming soon')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The computer's bots, each opening its settings in place of this list. */
function ComputerBots({ computer }: { computer: BotSettingsComputer }): React.JSX.Element | null {
  const t = useTranslate()
  const bots = useHostBots(computer.hostId)
  if (bots.length === 0) {
    return null
  }
  return (
    <SettingsInsetGroup title={t('settings.bots.title', 'Bots')}>
      {bots.map((bot) => (
        <SettingsInsetRow
          key={bot.id}
          icon={<BotAvatar bot={bot} className="size-6 rounded-md text-xs" />}
          title={bot.name}
          detail={[
            botAgentLabel(bot.agent),
            bot.paused
              ? t('bots.settingsPage.paused', 'Paused')
              : t('bots.settingsPage.active', 'Active')
          ].join(' · ')}
          onOpen={() => openBotSettingsPage(bot.id)}
        />
      ))}
    </SettingsInsetGroup>
  )
}

function ServerEnableRow({
  hostId,
  host
}: {
  hostId: ExecutionHostId
  host: string
}): React.JSX.Element {
  const t = useTranslate()
  const { enabled, blocked, set } = useServerBotsEnabled(hostId, host)
  return (
    <SettingsSwitchRow
      label={t('settings.bots.enableOnHost', 'Enable bots on {{host}}', { host })}
      description={
        blocked
          ? t('settings.bots.teamDisabled', 'Bots are turned off by your team.')
          : t(
              'settings.bots.enableOnHostDescription',
              'Lets {{host}}’s bots take messages and run automations, for every device paired to it. Turning this off hides them everywhere; their folders, memory and chats stay on {{host}}.',
              { host }
            )
      }
      checked={enabled ?? false}
      disabled={enabled === null || blocked}
      onChange={() => void set(!enabled)}
    />
  )
}

/** The account a live server runs as, or why it has none. */
function useServerAccountLine(computer: BotSettingsComputer): string | null {
  const t = useTranslate()
  const account = useBotHostOrcaAccount(computer.hostId)
  if (!account || account.state === 'unconfigured') {
    return null
  }
  if (account.state === 'signed-in') {
    return account.email ?? null
  }
  return account.state === 'signed-out'
    ? t('settings.bots.group.signedOut', 'Signed out of Orca')
    : t('settings.bots.group.signInChanged', 'Orca sign-in changed')
}

function ServerGroup({ computer }: { computer: BotSettingsComputer }): React.JSX.Element {
  const t = useTranslate()
  const host = computer.name
  if (computer.state === 'update-needed') {
    return (
      <SettingsGroup
        icon={Server}
        title={host}
        detail={t(
          'settings.bots.group.updateNeeded',
          'Update Orca on {{host}} to manage its bots here',
          {
            host
          }
        )}
      />
    )
  }
  if (computer.state === 'offline') {
    return (
      <SettingsGroup
        icon={Server}
        title={host}
        detail={t('settings.bots.group.offline', 'Can’t reach {{host}}', { host })}
      />
    )
  }
  return <LiveServerGroup computer={computer} />
}

function LiveServerGroup({ computer }: { computer: BotSettingsComputer }): React.JSX.Element {
  const t = useTranslate()
  const host = computer.name
  return (
    <SettingsGroup icon={Server} title={host} detail={useServerAccountLine(computer)}>
      <ServerEnableRow hostId={computer.hostId} host={host} />
      <ComputerBots computer={computer} />
      <ComputerConnectors computer={computer} />
      <GoogleAccountSettings target={botHostTarget(computer.hostId)} />
      <ComposioKeySection
        computer={computer}
        description={t(
          'settings.bots.composioKeyOnHost',
          'One key for every bot on {{host}}, for the apps you connect at Composio. Your app sign-ins are held by Composio.',
          { host }
        )}
      />
    </SettingsGroup>
  )
}

function ComposioKeySection({
  computer,
  description
}: {
  computer: BotSettingsComputer
  description: string
}): React.JSX.Element {
  const t = useTranslate()
  const holder = useComposioEventsHolder(computer.hostId)
  const holderName = useAppStore((state) =>
    holder ? selectExecutionHostDisplayLabel(state, holder) : null
  )
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={t('settings.bots.composioKey', 'Composio key')}
        description={description}
      />
      <ComposioKeyControl hostId={computer.hostId} />
      {holder === null ? null : (
        <p role="status" className="text-xs text-muted-foreground">
          {t(
            'settings.bots.composioEventsElsewhere',
            'Composio events for this key go to {{holder}}. Use a separate key on {{host}}.',
            {
              holder:
                holderName ?? t('settings.bots.composioEventsAnotherComputer', 'another computer'),
              host: computer.name
            }
          )}
        </p>
      )}
    </section>
  )
}

/** This computer's group: its connectors, Google and Composio key; its switch is at the top. */
function LocalGroup({ computer }: { computer: BotSettingsComputer }): React.JSX.Element {
  const t = useTranslate()
  const email = useAppStore((state) => state.orcaProfileAuthStatus?.cloud?.email ?? null)
  return (
    <SettingsGroup icon={Laptop} title={computer.name} detail={email}>
      <ComputerBots computer={computer} />
      <ComputerConnectors computer={computer} />
      <GoogleAccountSettings target={botHostTarget(computer.hostId)} />
      <ComposioKeySection
        computer={computer}
        description={t(
          'settings.bots.composioKeyDescription',
          'One key for every bot on this computer, for the apps you connect at Composio. Your app sign-ins are held by Composio.'
        )}
      />
    </SettingsGroup>
  )
}

export function BotComputerGroup({
  computer
}: {
  computer: BotSettingsComputer
}): React.JSX.Element {
  return computer.local ? <LocalGroup computer={computer} /> : <ServerGroup computer={computer} />
}
