// The Share dialog on the bot's own share list: picks wait as chips until Share adds them through its
// host, which emails each invite as its signed-in account (the owner row); removes and re-sends too.
// Slack- and GitHub-only people come from, and are edited through, each connector's Who can ask.
import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostOrcaAccount } from '@/lib/bot-host-orca-account'
import type { Bot, BotMember } from '../../../../../shared/bot-types'
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
  type TeamShareConnectorAdds,
  type TeamShareFoundByConnector
} from './BotTeamShareConnectorPeople'
import { addBotTeamShare, removeBotTeamShare, resendBotTeamShare } from './bot-team-share-rpc'
import { useTeamShareClose } from './use-team-share-close'

/** A pick waiting for Share; a Slack or GitHub person keeps the member their connector saves. */
type StagedPerson = {
  suggestion: TeamShareSuggestion
  connector?: { key: string; member: BotMember }
}

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
  const [staged, setStaged] = useState<StagedPerson[]>([])
  const [adds] = useState<TeamShareConnectorAdds>(() => new Map())
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
  const stagedPeople = staged.map((entry) => entry.suggestion)
  const close = useTeamShareClose(stagedPeople, query, onClose)
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
  // Invites go to the host in one call; each connector then confirms and saves its own people.
  const share = async (): Promise<void> => {
    setStaged([])
    const emails = staged.flatMap(({ suggestion }) =>
      suggestion.kind === 'invite' ? [suggestion.email] : []
    )
    if (emails.length > 0) {
      void addBotTeamShare(bot, emails).catch(failed)
    }
    const byConnector = Map.groupBy(
      staged.flatMap(({ connector }) => (connector ? [connector] : [])),
      (connector) => connector.key
    )
    for (const [key, picked] of byConnector) {
      await adds.get(key)?.(picked.map((connector) => connector.member))
    }
  }
  return (
    <BotTeamShareDialog
      bot={bot}
      hostName={hostLabel ?? t('bots.teamShare.thisComputer', 'this computer')}
      owner={owner}
      people={teamSharePeople(bot.shares)}
      query={query}
      onQueryChange={setQuery}
      suggestions={suggestions}
      staged={stagedPeople}
      onStage={stage}
      onUnstage={(suggestion) =>
        setStaged((current) => current.filter((entry) => entry.suggestion.key !== suggestion.key))
      }
      onShare={() => void share()}
      onCancelStaged={() => setStaged([])}
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
      onShareAgain={(person) => void resendBotTeamShare(bot, person.key).catch(failed)}
      onClose={close}
    >
      {connectors.map((entry) => (
        <TeamShareConnectorPeople
          key={entry.key}
          bot={bot}
          entry={entry}
          query={query}
          report={setFound}
          adds={adds}
        />
      ))}
    </BotTeamShareDialog>
  )
}
