import type { Bot } from '../../../../shared/bot-types'
import type { PairedServerAskCard } from '../../../../shared/rpc-contract/paired-server-asks-params'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { openBotChat } from '@/lib/bot-catalog'
import { openBotSession } from './bot-session-open'
import { useTranslate } from '@/i18n/use-translate'
import { openOrchestrationDispatch } from '@/lib/agent-session/open/open-agent-message-sender'
import { WorktreeHostContextBadge } from '@/components/sidebar/workspace-card/host/WorktreeHostContextBadge'
import { useBotHostLabel } from './use-bot-host-label'
import { NeedRow } from './BotNeedRow'

/** Who on the paired server asks: its agent's bot name, else its own name, else how its mail is signed. */
export function pairedAskSenderName(card: PairedServerAskCard): string {
  return card.from.sender?.bot?.name ?? card.from.sender?.name ?? card.from.label
}

/** Opens the server chat the ask came from, by its address on that server, whoever its agent is.
 *  The card names that server by its agent's computer's catalog, so a window paired to that
 *  computer opens the agent's own chat there instead. */
export async function openPairedAskChat(bot: Bot, card: PairedServerAskCard): Promise<void> {
  if (bot.hostId !== LOCAL_EXECUTION_HOST_ID) {
    openBotSession(bot, await openBotChat(bot))
    return
  }
  return openOrchestrationDispatch(card.rootSession, pairedAskSenderName(card), {
    kind: 'environment',
    environmentId: card.environmentId
  })
}

export function PairedAskNeedRow({
  bot,
  card
}: {
  bot: Bot
  card: PairedServerAskCard
}): React.JSX.Element {
  const t = useTranslate()
  // Named by the agent's computer, whose catalog the card's server id is from.
  const catalogLabel = useBotHostLabel(toRuntimeExecutionHostId(card.environmentId))
  const hostLabel = card.serverName || catalogLabel
  const name = bot.name
  return (
    <NeedRow
      kind="approval"
      title={t('bots.needs.pairedAsk', '{{from}} wants to message {{name}}', {
        from: pairedAskSenderName(card),
        name
      })}
      host={hostLabel ? <WorktreeHostContextBadge label={hostLabel} /> : null}
      detail={t('bots.needs.pairedAskDetail', 'Permission · Message {{name}}', { name })}
      action={{
        label: t('bots.needs.open', 'Open'),
        onOpen: () => void openPairedAskChat(bot, card)
      }}
    />
  )
}
