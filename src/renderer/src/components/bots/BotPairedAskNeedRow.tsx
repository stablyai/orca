import type { Bot } from '../../../../shared/bot-types'
import type { PairedServerAskCard } from '../../../../shared/rpc-contract/paired-server-asks-params'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { useTranslate } from '@/i18n/use-translate'
import { openOrchestrationDispatch } from '@/lib/agent-session/open/open-agent-message-sender'
import { WorktreeHostContextBadge } from '@/components/sidebar/workspace-card/host/WorktreeHostContextBadge'
import { useBotHostLabel } from './use-bot-host-label'
import { NeedRow } from './BotNeedRow'

/** Who on the paired server asks: its agent's bot name, else its own name, else how its mail is signed. */
export function pairedAskSenderName(card: PairedServerAskCard): string {
  return card.from.sender?.bot?.name ?? card.from.sender?.name ?? card.from.label
}

/** An agent on a paired server wants to message `bot`: the permission row, opening the server chat
 *  the card is answered in. */
/** Opens the server chat the ask came from, by its address on that server, whoever its agent is. */
export function openPairedAskChat(card: PairedServerAskCard): Promise<void> {
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
  const hostLabel = useBotHostLabel(toRuntimeExecutionHostId(card.environmentId))
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
      action={{ label: t('bots.needs.open', 'Open'), onOpen: () => void openPairedAskChat(card) }}
    />
  )
}
