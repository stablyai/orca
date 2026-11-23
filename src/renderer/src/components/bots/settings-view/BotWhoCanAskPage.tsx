// Who can ask the bot, every connector at once: each Slack workspace, Linear workspace and GitHub org's own whole list.
import type { Bot, BotLinear } from '../../../../../shared/bot-types'
import type { ConnectorGitHubInstallation } from '../../../../../shared/connector-bot-github-contract'
import { BotNoConnectors } from '../../settings/bots/BotConnectorsSection'
import { type BotConnectorEntry, useBotConnectorEntries } from '../bot-connector-entries'
import { botConnectorTitleText } from '../bot-connector-titles'
import { ACCOUNT_CONNECTORS } from '../bot-connectors'
import { BotWhoCanAskList, type BotWhoCanAskService } from '../BotWhoCanAskList'
import { useGitHubCard } from '../github/BotGitHubCard'
import { useLinearCard } from '../linear/BotLinearCard'
import { useSlackWhoCanAsk } from '../slack/use-slack-who-can-ask'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { BotPairedServersWhoCanAsk } from './BotPairedServersWhoCanAsk'
import { pairedServerAsksOn } from '../paired-server-asks-on'

type PeopleEntry = Extract<BotConnectorEntry, { kind: 'slack' | 'linear' | 'github' }>

function ConnectorPeople({
  bot,
  entry,
  people
}: {
  bot: Bot
  entry: PeopleEntry
  people: BotWhoCanAskService
}): React.JSX.Element {
  const connector = ACCOUNT_CONNECTORS.find((candidate) => candidate.id === entry.kind)
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="flex items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
        {connector ? <connector.Icon className="size-3.5 shrink-0" /> : null}
        <span className="min-w-0 truncate">{botConnectorTitleText(entry.title)}</span>
      </h3>
      <div className="rounded-[10px] bg-foreground/[0.035] p-3">
        <BotWhoCanAskList bot={bot} service={people} />
      </div>
    </section>
  )
}

function SlackPeople({
  bot,
  entry
}: {
  bot: Bot
  entry: PeopleEntry & { kind: 'slack' }
}): React.JSX.Element {
  return <ConnectorPeople bot={bot} entry={entry} people={useSlackWhoCanAsk(bot, entry.teamId)} />
}

function LinearPeople({
  bot,
  entry,
  linear
}: {
  bot: Bot
  entry: PeopleEntry
  linear: BotLinear
}): React.JSX.Element {
  return <ConnectorPeople bot={bot} entry={entry} people={useLinearCard(bot, linear).people} />
}

function GitHubPeople({
  bot,
  entry,
  installation
}: {
  bot: Bot
  entry: PeopleEntry
  installation: ConnectorGitHubInstallation | undefined
}): React.JSX.Element {
  return (
    <ConnectorPeople bot={bot} entry={entry} people={useGitHubCard(bot, installation).people} />
  )
}

export function BotWhoCanAskPage({ bot }: { bot: Bot }): React.JSX.Element {
  const entries = useBotConnectorEntries(bot).filter(
    (entry): entry is PeopleEntry =>
      entry.kind === 'slack' || entry.kind === 'linear' || entry.kind === 'github'
  )
  // Paired servers ask agents on this computer once it takes their asks: listed even with no connector.
  const pairedServers =
    bot.hostId === LOCAL_EXECUTION_HOST_ID && pairedServerAsksOn() ? (
      <BotPairedServersWhoCanAsk bot={bot} />
    ) : null
  if (entries.length === 0) {
    return (
      <>
        <BotNoConnectors bot={bot} />
        {pairedServers}
      </>
    )
  }
  return (
    <>
      {entries.map((entry) => {
        switch (entry.kind) {
          case 'slack':
            return <SlackPeople key={entry.key} bot={bot} entry={entry} />
          case 'linear':
            return <LinearPeople key={entry.key} bot={bot} entry={entry} linear={entry.linear} />
          case 'github':
            return (
              <GitHubPeople
                key={entry.key}
                bot={bot}
                entry={entry}
                installation={entry.installation}
              />
            )
        }
      })}
      {pairedServers}
    </>
  )
}
