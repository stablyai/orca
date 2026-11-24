// The Share dialog on the bot's own share list: adds, removes and re-sends through its host, which
// emails each invite as its signed-in account (the owner row) and keeps whether the email went out.
import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostOrcaAccount } from '@/lib/bot-host-orca-account'
import type { Bot } from '../../../../../shared/bot-types'
import { botErrorMessage } from '../bot-presentation'
import { useBotHostLabel } from '../use-bot-host-label'
import { BotTeamShareDialog } from './BotTeamShareDialog'
import { teamSharePeople, teamShareSuggestions } from './bot-team-share-people'
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
  const account = useBotHostOrcaAccount(bot.hostId)
  const hostLabel = useBotHostLabel(bot.hostId)
  const owner =
    account?.state === 'signed-in' && account.email
      ? { name: account.displayName ?? account.email, email: account.email, links: [] }
      : null
  const failed = (error: unknown) => toast.error(botErrorMessage(error))
  return (
    <BotTeamShareDialog
      bot={bot}
      hostName={hostLabel ?? t('bots.teamShare.thisComputer', 'this computer')}
      owner={owner}
      people={teamSharePeople(bot.shares)}
      query={query}
      onQueryChange={setQuery}
      suggestions={teamShareSuggestions(query, bot.shares)}
      onAdd={(suggestion) => {
        // Only an email adds here; Slack and GitHub people are added from Who can ask.
        if (suggestion.kind === 'invite') {
          setQuery('')
          void addBotTeamShare(bot, suggestion.email).catch(failed)
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
    />
  )
}
