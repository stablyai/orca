// Slack- and GitHub-only people in the Share dialog: each workspace's or org's own Who can ask (its
// service and hook), so a pick is confirmed and saved, and a removal made, exactly as Who can ask does.
import { useEffect, useEffectEvent } from 'react'
import { botMemberSource, type Bot, type BotMember } from '../../../../../shared/bot-types'
import type { BotConnectorEntry } from '../../../../../shared/bots/bot-connector-entries'
import { useBotConnectorEntries } from '../bot-connector-entries'
import { BotWhoCanAskSaveFailed, type BotWhoCanAskService } from '../BotWhoCanAskList'
import { asMember, memberSearchText, useMemberSearch } from '../BotWhoCanAskPicker'
import { useGitHubCard } from '../github/BotGitHubCard'
import { useSlackWhoCanAsk } from '../slack/use-slack-who-can-ask'
import { useBotWhoCanAsk } from '../use-bot-who-can-ask'
import type { TeamSharePerson, TeamShareSuggestion } from './bot-team-share-people'
import { TeamSharePersonRow } from './BotTeamShareRows'

type PeopleEntry = Extract<BotConnectorEntry, { kind: 'slack' | 'github' }>

/**
 * One connector's part in the Add field: not searchable (not set up yet, or full), waiting for a query,
 * searching, or what it found for `query` and how to add one.
 */
export type TeamShareConnectorFound =
  | { status: 'off' }
  | { status: 'idle' }
  | { status: 'searching' }
  | {
      status: 'ready'
      query: string
      suggestions: TeamShareSuggestion[]
      pick: (key: string) => void
    }

export type TeamShareFoundByConnector = Readonly<Record<string, TeamShareConnectorFound>>

type Report = (update: (found: TeamShareFoundByConnector) => TeamShareFoundByConnector) => void

export function useTeamShareConnectors(bot: Bot): PeopleEntry[] {
  return useBotConnectorEntries(bot).filter(
    (entry): entry is PeopleEntry => entry.kind === 'slack' || entry.kind === 'github'
  )
}

function withoutKey(found: TeamShareFoundByConnector, key: string): TeamShareFoundByConnector {
  return Object.fromEntries(Object.entries(found).filter(([entry]) => entry !== key))
}

function personOf(member: BotMember, place: string): TeamSharePerson {
  return botMemberSource(member) === 'github'
    ? { kind: 'github', key: member.id, login: member.name || member.id, place }
    : { kind: 'slack', key: member.id, name: member.name || member.id, workspace: place }
}

function ConnectorSearch({
  entryKey,
  kind,
  place,
  service,
  query,
  listed,
  onPick,
  report
}: {
  entryKey: string
  kind: PeopleEntry['kind']
  place: string
  service: BotWhoCanAskService
  query: string
  listed: readonly BotMember[]
  onPick: (member: BotMember) => void
  report: Report
}): null {
  const { search } = useMemberSearch(service, query)
  const publish = useEffectEvent(() => {
    const needle = memberSearchText(query).toLowerCase()
    const found =
      search.status === 'ready'
        ? search.found.members.filter(
            (person) =>
              !person.app &&
              person.id !== service.ownerId &&
              !(service.otherOwnerIds?.includes(person.id) ?? false) &&
              !listed.some((member) => member.id === person.id) &&
              [person.name, person.handle ?? ''].some((name) => name.toLowerCase().includes(needle))
          )
        : []
    const keyOf = (id: string): string => `${entryKey}\n${id}`
    const value: TeamShareConnectorFound =
      search.status === 'loading'
        ? { status: 'searching' }
        : {
            status: 'ready',
            query: query.trim(),
            suggestions: found.map((person) => ({
              kind,
              key: keyOf(person.id),
              name: person.name,
              detail: place
            })),
            pick: (key) => {
              const person = found.find((entry) => keyOf(entry.id) === key)
              if (person) {
                onPick(asMember(person, service))
              }
            }
          }
    report((all) => ({ ...all, [entryKey]: value }))
  })
  // The search answers on its own clock, so what it found goes up when it lands or the list changes.
  const listedKey = listed.map((member) => member.id).join('\n')
  useEffect(() => {
    publish()
  }, [search, listedKey])
  return null
}

function ConnectorPeople({
  bot,
  entry,
  service,
  query,
  report
}: {
  bot: Bot
  entry: PeopleEntry
  service: BotWhoCanAskService
  query: string
  report: Report
}): React.JSX.Element {
  const { listed, add, remove, save, capped } = useBotWhoCanAsk(bot, service)
  const place = entry.title.name ?? entry.title.service
  // As the picker's Add button: only a connector that is set up and has room is searched.
  const searchable = service.outsiders !== null && !capped
  const searching = searchable && query.trim() !== ''
  useEffect(() => {
    if (!searching) {
      report((all) => ({ ...all, [entry.key]: { status: searchable ? 'idle' : 'off' } }))
    }
  }, [report, entry.key, searchable, searching])
  useEffect(() => () => report((all) => withoutKey(all, entry.key)), [report, entry.key])
  return (
    <>
      {listed.map((member) => (
        <TeamSharePersonRow
          key={`${entry.key}\n${member.id}`}
          person={personOf(member, place)}
          onRemove={() => remove(member)}
        />
      ))}
      {save.kind === 'failed' ? (
        <li className="px-6 py-1.5">
          <BotWhoCanAskSaveFailed message={save.message} retry={save.retry} />
        </li>
      ) : null}
      {searching ? (
        <ConnectorSearch
          entryKey={entry.key}
          kind={entry.kind}
          place={place}
          service={service}
          query={query}
          listed={listed}
          onPick={(member) => void add([member])}
          report={report}
        />
      ) : null}
    </>
  )
}

function SlackPeople(props: {
  bot: Bot
  entry: PeopleEntry & { kind: 'slack' }
  query: string
  report: Report
}): React.JSX.Element {
  return <ConnectorPeople {...props} service={useSlackWhoCanAsk(props.bot, props.entry.teamId)} />
}

function GitHubPeople(props: {
  bot: Bot
  entry: PeopleEntry & { kind: 'github' }
  query: string
  report: Report
}): React.JSX.Element {
  return (
    <ConnectorPeople
      {...props}
      service={useGitHubCard(props.bot, props.entry.installation).people}
    />
  )
}

/** One connector's rows, and its search for the Add field while it has a query. */
export function TeamShareConnectorPeople(props: {
  bot: Bot
  entry: PeopleEntry
  query: string
  report: Report
}): React.JSX.Element {
  const { entry } = props
  return entry.kind === 'slack' ? (
    <SlackPeople {...props} entry={entry} />
  ) : (
    <GitHubPeople {...props} entry={entry} />
  )
}
