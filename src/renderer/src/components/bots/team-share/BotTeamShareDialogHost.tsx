// The Share dialog on the agent's one people list, the same list Settings › Sharing draws.
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { useBotHostLabel } from '../use-bot-host-label'
import { BotTeamShareDialog } from './BotTeamShareDialog'
import { useBotTeamShareList } from './use-bot-team-share-list'
import { useTeamShareClose } from './use-team-share-close'

export function BotTeamShareDialogHost({
  bot,
  onClose
}: {
  bot: Bot
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { connectorRows, ...list } = useBotTeamShareList(bot)
  const hostLabel = useBotHostLabel(bot.hostId)
  const close = useTeamShareClose(list.staged, list.query, onClose, list.sharing)
  return (
    <BotTeamShareDialog
      bot={bot}
      hostName={hostLabel ?? t('bots.teamShare.thisComputer', 'this computer')}
      {...list}
      onClose={close}
    >
      {connectorRows}
    </BotTeamShareDialog>
  )
}
