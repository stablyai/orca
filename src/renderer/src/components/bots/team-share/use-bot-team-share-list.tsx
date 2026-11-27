// The one owner of an agent's people list, for the Share dialog and Settings › Sharing alike: picks
// wait as chips until Share adds them through its host, which emails each invite as its signed-in
// account (the owner row); removes and re-sends too. Slack- and GitHub-only people come from, and are
// edited through, each connector's Who can ask.
import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostOrcaAccount } from '@/lib/bot-host-orca-account'
import type { Bot } from '../../../../../shared/bot-types'
import { botErrorMessage } from '../bot-presentation'
import {
  teamSharePeople,
  teamShareSuggestions,
  type TeamShareOwner,
  type TeamSharePerson,
  type TeamShareSuggestion
} from './bot-team-share-people'
import {
  TeamShareConnectorPeople,
  useTeamShareConnectors,
  teamShareConnectorMembers,
  type TeamShareFoundByConnector
} from './BotTeamShareConnectorPeople'
import { addBotTeamShare, removeBotTeamShare, resendBotTeamShare } from './bot-team-share-rpc'
import {
  shareStagedPeople,
  type StagedPerson,
  type TeamShareConnectorAdds
} from './share-staged-people'

export type BotTeamShareList = {
  /** The account the agent's host is signed in as; null while it isn't. */
  owner: TeamShareOwner | null
  people: readonly TeamSharePerson[]
  query: string
  onQueryChange: (query: string) => void
  /** What the field found for `query`; null while it is empty or still searching. */
  suggestions: readonly TeamShareSuggestion[] | null
  /** Picked in the field, not saved until Share. */
  staged: readonly TeamShareSuggestion[]
  onStage: (suggestion: TeamShareSuggestion) => void
  onUnstage: (suggestion: TeamShareSuggestion) => void
  onShare: () => void
  /** Share is saving; its buttons wait until it settles. */
  sharing: boolean
  onCancelStaged: () => void
  onRemove: (person: TeamSharePerson) => void
  onResend: (person: Extract<TeamSharePerson, { kind: 'invite' }>) => void
  /** A declined person, asked again under a new share id. */
  onShareAgain: (person: Extract<TeamSharePerson, { kind: 'account' }>) => void
  /** Slack- and GitHub-only people from Who can ask, drawn after `people`; they also feed the search. */
  connectorRows: React.ReactNode
  /** Someone besides the owner has access or an invite: an account, an invite or a connector member. */
  othersListed: boolean
}

export function useBotTeamShareList(bot: Bot): BotTeamShareList {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<TeamShareFoundByConnector>({})
  const [staged, setStaged] = useState<StagedPerson[]>([])
  const [adds] = useState<TeamShareConnectorAdds>(() => new Map())
  // While Share saves, its confirmations sit on top; the picks stay until it settles.
  const [sharing, setSharing] = useState(false)
  const connectors = useTeamShareConnectors(bot)
  const account = useBotHostOrcaAccount(bot.hostId)
  const owner =
    account?.state === 'signed-in' && account.email
      ? { name: account.displayName ?? account.email, email: account.email, links: [] }
      : null
  const failed = (error: unknown) => toast.error(botErrorMessage(error))
  const invite = teamShareSuggestions(query, bot.shares)
  const searches = Object.values(found)
  const typed = query.trim()
  // Only what was found for this very query; a connector yet to answer it (just typed) still searches.
  const fromConnectors = searches.flatMap((search) =>
    search.status === 'ready' && search.query === typed ? search.suggestions : []
  )
  const stillSearching = searches.some(
    (search) => search.status !== 'off' && !(search.status === 'ready' && search.query === typed)
  )
  const offered = invite === null ? null : [...invite, ...fromConnectors]
  // Nothing shows while a connector still searches and nobody is found yet, so No match never flashes.
  const stagedKeys = new Set(staged.map((entry) => entry.suggestion.key))
  const unpicked = offered?.filter((suggestion) => !stagedKeys.has(suggestion.key)) ?? null
  const suggestions: TeamShareSuggestion[] | null =
    unpicked !== null && unpicked.length === 0 && stillSearching ? null : unpicked
  const stage = (suggestion: TeamShareSuggestion): void => {
    setQuery('')
    if (suggestion.kind === 'invite') {
      setStaged((current) => [...current, { suggestion }])
      return
    }
    for (const [key, search] of Object.entries(found)) {
      const member = search.status === 'ready' ? search.member(suggestion.key) : undefined
      if (member) {
        setStaged((current) => [...current, { suggestion, connector: { key, member } }])
        return
      }
    }
  }
  // Only those saved leave the field; a declined or failed one stays picked to try again.
  const share = async (): Promise<void> => {
    setSharing(true)
    const saved = await shareStagedPeople(
      staged,
      (emails) =>
        addBotTeamShare(bot, emails).then(
          () => true,
          (error: unknown) => {
            failed(error)
            return false
          }
        ),
      adds
    )
    setStaged((current) => current.filter((entry) => !saved.has(entry.suggestion.key)))
    setSharing(false)
  }
  const people = teamSharePeople(bot.shares)
  return {
    owner,
    people,
    othersListed:
      people.length > 0 ||
      connectors.some((entry) => teamShareConnectorMembers(bot, entry).length > 0),
    query,
    onQueryChange: setQuery,
    suggestions,
    staged: staged.map((entry) => entry.suggestion),
    onStage: stage,
    onUnstage: (suggestion) =>
      setStaged((current) => current.filter((entry) => entry.suggestion.key !== suggestion.key)),
    sharing,
    onShare: () => void share(),
    onCancelStaged: () => {
      setStaged([])
      setQuery('')
    },
    onRemove: (person) => void removeBotTeamShare(bot, person.key).catch(failed),
    onResend: (person) =>
      void resendBotTeamShare(bot, person.key)
        .then(({ emailed }) => {
          if (!emailed) {
            toast.message(t('bots.teamShare.emailNotSent', 'Email not sent yet'))
          }
        })
        .catch(failed),
    onShareAgain: (person) => void resendBotTeamShare(bot, person.key).catch(failed),
    connectorRows: connectors.map((entry) => (
      <TeamShareConnectorPeople
        key={entry.key}
        bot={bot}
        entry={entry}
        query={query}
        report={setFound}
        adds={adds}
      />
    ))
  }
}
