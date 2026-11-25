// The Share dialog on the bot's own share list: adds, removes and re-sends through its host, which
// emails each invite as its signed-in account (the owner row) and keeps whether the email went out.
// Slack- and GitHub-only people come from, and are edited through, each connector's Who can ask.
import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostOrcaAccount } from '@/lib/bot-host-orca-account'
import type { Bot } from '../../../../../shared/bot-types'
import { botErrorMessage } from '../bot-presentation'
import { useBotHostLabel } from '../use-bot-host-label'
import { BotTeamShareDialog } from './BotTeamShareDialog'
import {
  teamSharePeople,
  teamShareSuggestions,
  type TeamShareSuggestion
} from './bot-team-share-people'
import {
  TeamShareConnectorPeople,
  useTeamShareConnectors,
  type TeamShareFoundByConnector
} from './BotTeamShareConnectorPeople'
import { addBotTeamShare, removeBotTeamShare, resendBotTeamShare } from './bot-team-share-rpc'

export function BotTeamShareDialogHost({
  bot,
  onClose
}: {
  bot: Bot
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<TeamShareFoundByConnector>({})
  const connectors = useTeamShareConnectors(bot)
  const account = useBotHostOrcaAccount(bot.hostId)
  const hostLabel = useBotHostLabel(bot.hostId)
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
  const suggestions: TeamShareSuggestion[] | null =
    offered !== null && offered.length === 0 && stillSearching ? null : offered
  return (
    <BotTeamShareDialog
      bot={bot}
      hostName={hostLabel ?? t('bots.teamShare.thisComputer', 'this computer')}
      owner={owner}
      people={teamSharePeople(bot.shares)}
      query={query}
      onQueryChange={setQuery}
      suggestions={suggestions}
      onAdd={(suggestion) => {
        setQuery('')
        if (suggestion.kind === 'invite') {
          void addBotTeamShare(bot, suggestion.email).catch(failed)
          return
        }
        // A Slack or GitHub person is confirmed and saved by their connector's Who can ask.
        for (const search of searches) {
          if (search.status === 'ready') {
            search.pick(suggestion.key)
          }
        }
      }}
      onRemove={(person) => void removeBotTeamShare(bot, person.key).catch(failed)}
      onResend={(person) =>
        void resendBotTeamShare(bot, person.key)
          .then(({ emailed }) => {
            if (!emailed) {
              toast.message(t('bots.teamShare.emailNotSent', 'Email not sent yet'))
            }
          })
          .catch(failed)
      }
      onClose={onClose}
    >
      {connectors.map((entry) => (
        <TeamShareConnectorPeople
          key={entry.key}
          bot={bot}
          entry={entry}
          query={query}
          report={setFound}
        />
      ))}
    </BotTeamShareDialog>
  )
}
